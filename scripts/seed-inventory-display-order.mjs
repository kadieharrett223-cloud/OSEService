/**
 * One-time seed of Inventory display order from the OLD_ERP Lift Availability data.
 *
 * Maps legacy Products.category -> products.inventory_group and
 * legacy Products.sortOrder -> products.inventory_sort_order, matching legacy rows to
 * canonical products by internal SKU first, then by operational alias.
 *
 * Presentation only: never touches quantities, demand, or customer queues.
 * Idempotent - safe to re-run. Requires migration 202608140003 to be applied first.
 *
 * Usage:
 *   node scripts/seed-inventory-display-order.mjs           (preview)
 *   node scripts/seed-inventory-display-order.mjs --apply   (write)
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const EXPORT_DIR = path.join(process.cwd(), "tmp", "exports");
const FALLBACK_GROUP = "Other / Unsorted";

function loadEnv() {
  const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

function normalizeSkuKey(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function latestExport(prefix) {
  const matches = readdirSync(EXPORT_DIR).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  if (!matches.length) throw new Error(`No export found for ${prefix}`);
  return JSON.parse(readFileSync(path.join(EXPORT_DIR, matches[matches.length - 1]), "utf8"));
}

loadEnv();
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { error: columnCheck } = await supabase.from("products").select("inventory_group").limit(1);
if (columnCheck) {
  console.error("products.inventory_group is missing. Apply migration 202608140003 first.");
  console.error(columnCheck.message);
  process.exit(1);
}

const legacyProducts = latestExport("azure-Products-");
const [{ data: products }, { data: aliases }] = await Promise.all([
  supabase.from("products").select("id, sku, canonical_name"),
  supabase.from("product_aliases").select("product_id, alias"),
]);

// Legacy rows are keyed by internal sku (000012) and by operational item code (4PHR-9X).
const productIdByKey = new Map();
for (const product of products ?? []) {
  const key = normalizeSkuKey(product.sku);
  if (key && !productIdByKey.has(key)) productIdByKey.set(key, product.id);
}
const productIdsByAlias = new Map();
for (const alias of aliases ?? []) {
  const key = normalizeSkuKey(alias.alias);
  if (!key) continue;
  const list = productIdsByAlias.get(key) ?? [];
  list.push(alias.product_id);
  productIdsByAlias.set(key, list);
}

// Later legacy rows win when the same identity appears twice.
const assignmentByProductId = new Map();
let unmatched = 0;
const groupCounts = new Map();

const ordered = [...legacyProducts].sort((a, b) => (a.sortOrder ?? 1e9) - (b.sortOrder ?? 1e9));
for (const legacy of ordered) {
  const group = String(legacy.category ?? "").trim() || FALLBACK_GROUP;
  const sortOrder = typeof legacy.sortOrder === "number" ? legacy.sortOrder : null;

  const targets = new Set();
  for (const candidate of [legacy.sku, legacy.itemCode]) {
    const key = normalizeSkuKey(candidate);
    if (!key) continue;
    if (productIdByKey.has(key)) targets.add(productIdByKey.get(key));
    for (const id of productIdsByAlias.get(key) ?? []) targets.add(id);
  }

  if (!targets.size) {
    unmatched += 1;
    continue;
  }

  for (const id of targets) {
    const existing = assignmentByProductId.get(id);
    // Prefer a real category over the fallback, then the earliest sequence position.
    if (existing && existing.group !== FALLBACK_GROUP && group === FALLBACK_GROUP) continue;
    if (existing && existing.sortOrder !== null && (sortOrder === null || sortOrder > existing.sortOrder)) continue;
    assignmentByProductId.set(id, { group, sortOrder });
  }
}

for (const { group } of assignmentByProductId.values()) {
  groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
}

const totalProducts = (products ?? []).length;
console.log(`Legacy rows: ${legacyProducts.length} | unmatched legacy rows: ${unmatched}`);
console.log(`Products in ERP: ${totalProducts} | receiving an assignment: ${assignmentByProductId.size} | falling to "${FALLBACK_GROUP}": ${totalProducts - assignmentByProductId.size}`);
console.log("\nGroup assignment counts:");
for (const [group, count] of [...groupCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${group}`);
}

const { data: knownGroups } = await supabase.from("inventory_display_groups").select("name");
const knownGroupNames = new Set((knownGroups ?? []).map((row) => row.name));
const missingGroups = [...groupCounts.keys()].filter((group) => !knownGroupNames.has(group));
if (missingGroups.length) {
  console.log(`\nGroups not present in inventory_display_groups (will sort just above "${FALLBACK_GROUP}"): ${missingGroups.join(", ")}`);
}

if (!APPLY) {
  console.log("\nPreview only. Re-run with --apply to write.");
  process.exit(0);
}

let updated = 0;
for (const [productId, assignment] of assignmentByProductId) {
  const { error } = await supabase
    .from("products")
    .update({ inventory_group: assignment.group, inventory_sort_order: assignment.sortOrder })
    .eq("id", productId);
  if (error) {
    console.error(`Failed on ${productId}: ${error.message}`);
    process.exit(1);
  }
  updated += 1;
}

console.log(`\nApplied. ${updated} product(s) assigned a display group and order.`);
