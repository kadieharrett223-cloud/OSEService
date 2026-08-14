/**
 * Repairs product_aliases against the OLD_ERP Products export.
 *
 * The import attached operational codes to the wrong product (e.g. product 000011 "HK-4PC-6"
 * also holds 4PML-9), which routed containers and orders to the wrong SKU.
 *
 * For each product the legitimate codes are taken from its legacy row: sku, itemCode and the
 * legacy aliases array. Any alias outside that set is either moved to the product it actually
 * belongs to, or removed when no product claims it. Products with no legacy row are skipped.
 *
 * Usage:
 *   node scripts/fix-product-aliases.mjs           (preview)
 *   node scripts/fix-product-aliases.mjs --apply   (write)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const EXPORT_DIR = path.join(process.cwd(), "tmp", "exports");

const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
for (const line of raw.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const MANUFACTURER_PREFIX = /^(HL|HK|FB|YZ)-/i;
const PREFIX_MERGE_EXCEPTIONS = new Set(["AR1"]);
const normalizeSkuKey = (value) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
function canonicalSkuKey(value) {
  const full = normalizeSkuKey(value);
  const stripped = normalizeSkuKey(String(value ?? "").replace(MANUFACTURER_PREFIX, ""));
  if (!stripped || PREFIX_MERGE_EXCEPTIONS.has(stripped)) return full;
  return stripped;
}

function latestExport(prefix) {
  const matches = readdirSync(EXPORT_DIR).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  if (!matches.length) throw new Error(`No export found for ${prefix}`);
  return JSON.parse(readFileSync(path.join(EXPORT_DIR, matches[matches.length - 1]), "utf8"));
}

const legacyProducts = latestExport("azure-Products-");
const [{ data: products }, { data: aliases }] = await Promise.all([
  supabase.from("products").select("id, sku, canonical_name"),
  supabase.from("product_aliases").select("product_id, alias, source_type"),
]);

// The old ERP recycled sku numbers: 000011 was HK-4PC-6 (REMOVED) before becoming 4PML-9 (ACTIVE).
// The live identity is the ACTIVE row, falling back to the most recently updated one.
const legacyBySku = new Map();
for (const legacy of legacyProducts) {
  const key = normalizeSkuKey(legacy.sku);
  if (!key) continue;
  const current = legacyBySku.get(key);
  if (!current) {
    legacyBySku.set(key, legacy);
    continue;
  }
  const currentActive = String(current.status ?? "").toUpperCase() === "ACTIVE";
  const candidateActive = String(legacy.status ?? "").toUpperCase() === "ACTIVE";
  if (candidateActive && !currentActive) legacyBySku.set(key, legacy);
  else if (candidateActive === currentActive && String(legacy.updatedAt ?? "") > String(current.updatedAt ?? "")) {
    legacyBySku.set(key, legacy);
  }
}

// Legitimate codes for a product come from its own legacy row only.
const allowedByProduct = new Map();
const identityKeyByProduct = new Map();
for (const product of products ?? []) {
  const legacy = legacyBySku.get(normalizeSkuKey(product.sku));
  if (!legacy) continue;
  const allowed = new Set();
  for (const code of [legacy.sku, legacy.itemCode, ...(Array.isArray(legacy.aliases) ? legacy.aliases : [])]) {
    const key = canonicalSkuKey(code);
    if (key) allowed.add(key);
  }
  allowedByProduct.set(product.id, allowed);
  if (canonicalSkuKey(legacy.itemCode)) identityKeyByProduct.set(product.id, canonicalSkuKey(legacy.itemCode));
}

// Where should a stray code live? The product whose legacy itemCode matches it.
const productByIdentity = new Map();
for (const [productId, key] of identityKeyByProduct) {
  const set = productByIdentity.get(key) ?? new Set();
  set.add(productId);
  productByIdentity.set(key, set);
}

const existingPairs = new Set((aliases ?? []).map((row) => `${row.product_id}|${normalizeSkuKey(row.alias)}`));

const moves = [];
const removals = [];
let kept = 0;
let skippedNoLegacy = 0;

for (const alias of aliases ?? []) {
  const allowed = allowedByProduct.get(alias.product_id);
  if (!allowed) {
    skippedNoLegacy += 1;
    continue;
  }

  const key = canonicalSkuKey(alias.alias);
  if (!key || allowed.has(key)) {
    kept += 1;
    continue;
  }

  const owners = [...(productByIdentity.get(key) ?? [])].filter((id) => id !== alias.product_id).sort();
  const target = owners[0];

  if (target && !existingPairs.has(`${target}|${normalizeSkuKey(alias.alias)}`)) {
    moves.push({ alias: alias.alias, from: alias.product_id, to: target });
  } else {
    removals.push({ alias: alias.alias, from: alias.product_id, reason: target ? "already on correct product" : "no product claims this code" });
  }
}

const productById = new Map((products ?? []).map((product) => [product.id, product]));
const label = (id) => `${productById.get(id)?.sku ?? id} "${String(productById.get(id)?.canonical_name ?? "").slice(0, 26)}"`;

console.log(`product_aliases: ${(aliases ?? []).length}`);
console.log(`  legitimate (in legacy row)     : ${kept}`);
console.log(`  MOVE to the correct product    : ${moves.length}`);
console.log(`  REMOVE                         : ${removals.length}`);
console.log(`  skipped, product has no legacy row: ${skippedNoLegacy}`);

console.log("\nMoves:");
for (const move of moves.slice(0, 40)) console.log(`  "${move.alias}"  ${label(move.from)}  ->  ${label(move.to)}`);
if (moves.length > 40) console.log(`  ...${moves.length - 40} more`);

console.log("\nRemovals:");
for (const removal of removals.slice(0, 40)) console.log(`  "${removal.alias}"  from ${label(removal.from)}  (${removal.reason})`);
if (removals.length > 40) console.log(`  ...${removals.length - 40} more`);

if (!APPLY) {
  console.log("\nPreview only. Re-run with --apply to write, or --apply --moves-only to reassign without removing.");
  process.exit(0);
}

// Removing an alias from a recycled sku strips that product's only operational code,
// so removals stay opt-in until recycled identities are split into separate products.
const MOVES_ONLY = process.argv.includes("--moves-only");

const backupPath = path.join(process.cwd(), "tmp", `backup-product-aliases-${Date.now()}.json`);
writeFileSync(backupPath, JSON.stringify({ moves, removals }, null, 2), "utf8");
console.log(`\nBackup: ${backupPath}`);

for (const move of moves) {
  const { error } = await supabase
    .from("product_aliases")
    .update({ product_id: move.to })
    .eq("product_id", move.from)
    .eq("alias", move.alias);
  if (error) throw new Error(`move failed for ${move.alias}: ${error.message}`);
}
console.log(`Moved ${moves.length} alias(es).`);

if (MOVES_ONLY) {
  console.log(`Skipped ${removals.length} removal(s) (--moves-only).`);
  process.exit(0);
}

for (const removal of removals) {
  const { error } = await supabase
    .from("product_aliases")
    .delete()
    .eq("product_id", removal.from)
    .eq("alias", removal.alias);
  if (error) throw new Error(`remove failed for ${removal.alias}: ${error.message}`);
}
console.log(`Removed ${removals.length} alias(es).`);
