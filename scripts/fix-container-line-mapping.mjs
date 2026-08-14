/**
 * Rebuilds container_lines from the OLD_ERP container drafts.
 *
 * The alias table is polluted: some products carry aliases belonging to a different product
 * (e.g. product 000011 "HK-4PC-6" also holds 4PML-9), so container lines were attached to the
 * wrong product and inflated Incoming on the Inventory page.
 *
 * Each legacy container line is matched to the product whose OWN identity (sku or operational
 * alias) equals the part number, preferring an exact identity match over an alias-only match.
 * Anything ambiguous or unresolvable is reported and left untouched.
 *
 * Usage:
 *   node scripts/fix-container-line-mapping.mjs           (preview)
 *   node scripts/fix-container-line-mapping.mjs --apply   (write)
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

const drafts = latestExport("azure-ContainerDrafts-");
const [{ data: containers }, { data: products }, { data: aliases }, { data: existingLines }] = await Promise.all([
  supabase.from("containers").select("id, container_number, lifecycle_status"),
  supabase.from("products").select("id, sku, canonical_name"),
  supabase.from("product_aliases").select("product_id, alias"),
  supabase.from("container_lines").select("id, container_id, product_id, on_order_qty, received_qty"),
]);

const operationalSku = new Map();
for (const alias of aliases ?? []) {
  const candidate = String(alias.alias ?? "").trim().toUpperCase();
  if (!candidate || /^\d+$/.test(candidate)) continue;
  if (!operationalSku.has(alias.product_id)) operationalSku.set(alias.product_id, candidate);
}
const displaySku = (id) => operationalSku.get(id) ?? (products ?? []).find((p) => p.id === id)?.sku ?? "?";

// Identity match = the product's own sku or its operational (display) alias.
const identityByKey = new Map();
const aliasByKey = new Map();
const addTo = (map, key, id) => {
  if (!key) return;
  const set = map.get(key) ?? new Set();
  set.add(id);
  map.set(key, set);
};
for (const product of products ?? []) {
  addTo(identityByKey, canonicalSkuKey(product.sku), product.id);
  addTo(identityByKey, canonicalSkuKey(operationalSku.get(product.id)), product.id);
}
for (const alias of aliases ?? []) addTo(aliasByKey, canonicalSkuKey(alias.alias), alias.product_id);

function resolveProduct(partNumber) {
  const key = canonicalSkuKey(partNumber);
  const identity = [...(identityByKey.get(key) ?? [])].sort();
  if (identity.length) return { id: identity[0], how: "identity", ambiguous: identity.length > 1 };
  const viaAlias = [...(aliasByKey.get(key) ?? [])].sort();
  if (viaAlias.length) return { id: viaAlias[0], how: "alias", ambiguous: viaAlias.length > 1 };
  return null;
}

const draftByNumber = new Map();
for (const draft of drafts) {
  const number = String(draft.parsedContainerNumber ?? "").trim();
  if (!number) continue;
  draftByNumber.set(number, draft);
}

const desired = [];
const unresolved = [];
const containersTouched = [];

for (const container of containers ?? []) {
  const draft = draftByNumber.get(String(container.container_number ?? "").trim());
  if (!draft) continue;

  const legacyLines = (draft.onOrderAppliedItems?.length ? draft.onOrderAppliedItems : draft.items) ?? [];
  if (!Array.isArray(legacyLines) || !legacyLines.length) continue;

  // Legacy can repeat a part number within one container; collapse to one line per part.
  const qtyByPart = new Map();
  for (const line of legacyLines) {
    const part = String(line.partNumber ?? "").trim();
    if (!part) continue;
    qtyByPart.set(part, (qtyByPart.get(part) ?? 0) + Number(line.qty ?? 0));
  }

  containersTouched.push(container.id);
  for (const [part, qty] of qtyByPart) {
    const resolved = resolveProduct(part);
    if (!resolved) {
      unresolved.push({ container: container.container_number, part, qty });
      continue;
    }
    desired.push({
      container_id: container.id,
      containerNumber: container.container_number,
      product_id: resolved.id,
      part,
      on_order_qty: qty,
      how: resolved.how,
      ambiguous: resolved.ambiguous,
    });
  }
}

const currentByContainer = new Map();
for (const line of existingLines ?? []) {
  const list = currentByContainer.get(line.container_id) ?? [];
  list.push(line);
  currentByContainer.set(line.container_id, list);
}

const touched = new Set(containersTouched);
const removing = (existingLines ?? []).filter((line) => touched.has(line.container_id));

console.log(`Containers with a legacy draft : ${touched.size}`);
console.log(`Existing container_lines to replace: ${removing.length}`);
console.log(`Rebuilt container_lines           : ${desired.length}`);
console.log(`Unresolved part numbers (skipped) : ${unresolved.length}`);

const changes = [];
for (const line of desired) {
  const current = (currentByContainer.get(line.container_id) ?? []).find((row) => row.product_id === line.product_id);
  if (!current) changes.push(`  + ${String(line.containerNumber).padEnd(5)} ${line.part.padEnd(14)} qty ${String(line.on_order_qty).padStart(4)} -> ${displaySku(line.product_id)}${line.how === "alias" ? " (via alias)" : ""}`);
  else if (Number(current.on_order_qty ?? 0) !== line.on_order_qty) changes.push(`  ~ ${String(line.containerNumber).padEnd(5)} ${line.part.padEnd(14)} qty ${current.on_order_qty} -> ${line.on_order_qty} on ${displaySku(line.product_id)}`);
}
const desiredKeys = new Set(desired.map((line) => `${line.container_id}|${line.product_id}`));
for (const line of removing) {
  if (!desiredKeys.has(`${line.container_id}|${line.product_id}`)) {
    const number = (containers ?? []).find((c) => c.id === line.container_id)?.container_number;
    changes.push(`  - ${String(number).padEnd(5)} ${String(displaySku(line.product_id)).padEnd(14)} qty ${line.on_order_qty} removed (not in legacy container)`);
  }
}
console.log(`\nNet changes: ${changes.length}`);
for (const change of changes.slice(0, 60)) console.log(change);
if (changes.length > 60) console.log(`  ...${changes.length - 60} more`);
for (const row of unresolved.slice(0, 15)) console.log(`  unresolved: container ${row.container} part ${row.part} qty ${row.qty}`);

if (!APPLY) {
  console.log("\nPreview only. Re-run with --apply to write.");
  process.exit(0);
}

const backupPath = path.join(process.cwd(), "tmp", `backup-container-lines-${Date.now()}.json`);
writeFileSync(backupPath, JSON.stringify(removing, null, 2), "utf8");
console.log(`\nBackup of replaced lines: ${backupPath}`);

const removeIds = removing.map((line) => line.id);
for (let index = 0; index < removeIds.length; index += 200) {
  const { error } = await supabase.from("container_lines").delete().in("id", removeIds.slice(index, index + 200));
  if (error) throw new Error(`delete failed: ${error.message}`);
}

const payload = desired.map((line) => ({
  container_id: line.container_id,
  product_id: line.product_id,
  on_order_qty: line.on_order_qty,
  received_qty: 0,
}));
for (let index = 0; index < payload.length; index += 200) {
  const { error } = await supabase.from("container_lines").insert(payload.slice(index, index + 200));
  if (error) throw new Error(`insert failed: ${error.message}`);
}

console.log(`Applied. Replaced ${removeIds.length} line(s) with ${payload.length}.`);
