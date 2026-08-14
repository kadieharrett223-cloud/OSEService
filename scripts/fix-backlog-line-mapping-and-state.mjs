/**
 * Repairs the OLD_ERP backlog import using each line's exact source_record_id link
 * back to the legacy queue item (no fuzzy invoice matching).
 *
 * Two defects are corrected:
 *   1. product mapping - lines attached to a product whose SKU is not the legacy itemCode
 *   2. approval state  - every legacy backlog row is open, but most lines were stamped FULFILLED
 *
 * Only lines with source_system = OLD_ERP are touched. QuickBooks lines are left alone.
 * Prior values are written to a backup file before anything is applied.
 *
 * Usage:
 *   node scripts/fix-backlog-line-mapping-and-state.mjs           (preview)
 *   node scripts/fix-backlog-line-mapping-and-state.mjs --apply   (write)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const EXPORT_DIR = path.join(process.cwd(), "tmp", "exports");
const CLOSED_QUEUE_STATUS = ["REMOVED", "FULFILLED", "CANCELLED", "COMPLETED", "SHIPPED"];

const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
for (const line of raw.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const normalizeSkuKey = (value) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

function latestExport(prefix) {
  const matches = readdirSync(EXPORT_DIR).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  if (!matches.length) throw new Error(`No export found for ${prefix}`);
  return JSON.parse(readFileSync(path.join(EXPORT_DIR, matches[matches.length - 1]), "utf8"));
}

async function selectAll(table, columns, refine) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let query = supabase.from(table).select(columns).range(from, from + 999);
    if (refine) query = refine(query);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

const legacyById = new Map(latestExport("azure-InvoiceQueueItems-").map((row) => [String(row.id), row]));

const [products, aliases, lines] = await Promise.all([
  selectAll("products", "id, sku, canonical_name"),
  selectAll("product_aliases", "product_id, alias"),
  selectAll("shipping_order_lines", "id, product_id, approval_status, warehouse_status, source_record_id", (query) =>
    query.eq("source_system", "OLD_ERP")),
]);

// A legacy item code can resolve through either the internal SKU or an operational alias.
const productIdsByKey = new Map();
const addKey = (key, id) => {
  if (!key) return;
  const set = productIdsByKey.get(key) ?? new Set();
  set.add(id);
  productIdsByKey.set(key, set);
};
for (const product of products) addKey(normalizeSkuKey(product.sku), product.id);
for (const alias of aliases) addKey(normalizeSkuKey(alias.alias), alias.product_id);

const operationalSku = new Map();
for (const alias of aliases) {
  const candidate = String(alias.alias ?? "").trim().toUpperCase();
  if (!candidate || /^\d+$/.test(candidate)) continue;
  if (!operationalSku.has(alias.product_id)) operationalSku.set(alias.product_id, candidate);
}
const productById = new Map(products.map((product) => [product.id, product]));
const displaySku = (id) => operationalSku.get(id) ?? productById.get(id)?.sku ?? "?";

const isOpenInLegacy = (row) =>
  String(row.approvalStatus ?? "").toUpperCase() === "APPROVED"
  && row.removed !== true
  && !row.fulfilledAt
  && !CLOSED_QUEUE_STATUS.includes(String(row.queueStatus ?? "").toUpperCase());

const remaps = [];
const stateFixes = [];
const unresolved = [];
let alreadyCorrect = 0;
let legacyClosed = 0;

for (const line of lines) {
  const legacy = legacyById.get(String(line.source_record_id));
  if (!legacy) {
    unresolved.push({ id: line.id, why: "no legacy row for source_record_id" });
    continue;
  }

  const legacyKey = normalizeSkuKey(legacy.itemCode);
  const candidates = [...(productIdsByKey.get(legacyKey) ?? [])];

  // Duplicate legacy identities mean a code can hit two product rows; they merge into the
  // same canonical row on the page, so pick deterministically rather than skipping.
  const preferred = candidates
    .filter((id) => normalizeSkuKey(displaySku(id)) === legacyKey)
    .sort();
  const target = (preferred.length ? preferred : [...candidates].sort())[0];

  if (normalizeSkuKey(displaySku(line.product_id)) !== legacyKey) {
    if (target) {
      if (target !== line.product_id) {
        remaps.push({ id: line.id, from: line.product_id, to: target, legacyCode: legacy.itemCode });
      }
    } else {
      unresolved.push({ id: line.id, why: `legacy code ${legacy.itemCode} matches no product` });
      continue;
    }
  } else {
    alreadyCorrect += 1;
  }

  if (!isOpenInLegacy(legacy)) {
    legacyClosed += 1;
    continue;
  }

  if (line.approval_status !== "APPROVED" || line.warehouse_status !== "APPROVED") {
    stateFixes.push({ id: line.id, approval_status: line.approval_status, warehouse_status: line.warehouse_status });
  }
}

const remapSummary = new Map();
for (const remap of remaps) {
  const key = `${displaySku(remap.from)} -> ${displaySku(remap.to)}`;
  remapSummary.set(key, (remapSummary.get(key) ?? 0) + 1);
}

console.log(`OLD_ERP backlog lines: ${lines.length}`);
console.log(`  product mapping already correct : ${alreadyCorrect}`);
console.log(`  product mapping to be corrected : ${remaps.length}`);
console.log(`  legacy row says closed (skipped): ${legacyClosed}`);
console.log(`  state to reset to APPROVED      : ${stateFixes.length}`);
console.log(`  unresolved (left untouched)     : ${unresolved.length}`);

if (remapSummary.size) {
  console.log("\nRemapping:");
  for (const [key, count] of [...remapSummary.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }
}
for (const row of unresolved.slice(0, 10)) console.log(`  unresolved: ${row.id} - ${row.why}`);

if (!APPLY) {
  console.log("\nPreview only. Re-run with --apply to write.");
  process.exit(0);
}

const backupPath = path.join(process.cwd(), "tmp", `backup-backlog-repair-${Date.now()}.json`);
writeFileSync(backupPath, JSON.stringify({ remaps, stateFixes }, null, 2), "utf8");
console.log(`\nBackup of prior values: ${backupPath}`);

const byTarget = new Map();
for (const remap of remaps) {
  const list = byTarget.get(remap.to) ?? [];
  list.push(remap.id);
  byTarget.set(remap.to, list);
}
for (const [productId, ids] of byTarget) {
  for (let index = 0; index < ids.length; index += 200) {
    const { error } = await supabase
      .from("shipping_order_lines")
      .update({ product_id: productId })
      .in("id", ids.slice(index, index + 200));
    if (error) throw new Error(`remap failed: ${error.message}`);
  }
}
console.log(`Remapped ${remaps.length} line(s).`);

const stateIds = stateFixes.map((row) => row.id);
for (let index = 0; index < stateIds.length; index += 200) {
  const { error } = await supabase
    .from("shipping_order_lines")
    .update({ approval_status: "APPROVED", warehouse_status: "APPROVED", fulfillment_status: "PENDING" })
    .in("id", stateIds.slice(index, index + 200));
  if (error) throw new Error(`state fix failed: ${error.message}`);
}
console.log(`Reset ${stateIds.length} line(s) to APPROVED.`);
