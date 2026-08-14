/**
 * Corrects order lines that the migration stamped FULFILLED even though the OLD_ERP source
 * still shows them as open approved backlog.
 *
 * A line is only corrected when its OLD_ERP row (matched on invoice number + item code) is
 * approvalStatus APPROVED, not removed, has no fulfilledAt, and its queueStatus is not closed.
 * Anything that cannot be matched with confidence is left alone and reported.
 *
 * Writes a backup of prior states before applying, so the change can be undone.
 *
 * Usage:
 *   node scripts/fix-mislabeled-fulfilled-lines.mjs           (preview)
 *   node scripts/fix-mislabeled-fulfilled-lines.mjs --apply   (write)
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

const legacyQueue = latestExport("azure-InvoiceQueueItems-");
const legacyByInvoiceItem = new Map();
for (const row of legacyQueue) {
  const invoice = String(row.invoiceNumber ?? "").trim();
  if (!invoice) continue;
  for (const code of [row.itemCode, row.originalItemCode]) {
    const key = `${invoice}|${normalizeSkuKey(code)}`;
    if (!normalizeSkuKey(code)) continue;
    const list = legacyByInvoiceItem.get(key) ?? [];
    list.push(row);
    legacyByInvoiceItem.set(key, list);
  }
}

const [{ data: products }, { data: aliases }, { data: lines }] = await Promise.all([
  supabase.from("products").select("id, sku"),
  supabase.from("product_aliases").select("product_id, alias"),
  supabase
    .from("shipping_order_lines")
    .select("id, product_id, approval_status, warehouse_status, shipping_orders(qbo_invoices(invoice_number))")
    .eq("approval_status", "FULFILLED"),
]);

const skuKeysByProduct = new Map();
for (const product of products ?? []) {
  const list = skuKeysByProduct.get(product.id) ?? [];
  if (normalizeSkuKey(product.sku)) list.push(normalizeSkuKey(product.sku));
  skuKeysByProduct.set(product.id, list);
}
for (const alias of aliases ?? []) {
  const list = skuKeysByProduct.get(alias.product_id) ?? [];
  if (normalizeSkuKey(alias.alias)) list.push(normalizeSkuKey(alias.alias));
  skuKeysByProduct.set(alias.product_id, list);
}

const isOpenInLegacy = (row) =>
  String(row.approvalStatus ?? "").toUpperCase() === "APPROVED"
  && row.removed !== true
  && !row.fulfilledAt
  && !CLOSED_QUEUE_STATUS.includes(String(row.queueStatus ?? "").toUpperCase());

const toCorrect = [];
const leaveAlone = { legacyClosed: 0, noInvoice: 0, noLegacyMatch: 0 };

for (const line of lines ?? []) {
  const invoice = String(line.shipping_orders?.qbo_invoices?.invoice_number ?? "").trim();
  if (!invoice) {
    leaveAlone.noInvoice += 1;
    continue;
  }

  const legacyRows = (skuKeysByProduct.get(line.product_id) ?? [])
    .flatMap((key) => legacyByInvoiceItem.get(`${invoice}|${key}`) ?? []);

  if (!legacyRows.length) {
    leaveAlone.noLegacyMatch += 1;
    continue;
  }

  if (legacyRows.some(isOpenInLegacy)) {
    toCorrect.push({ id: line.id, approval_status: line.approval_status, warehouse_status: line.warehouse_status });
  } else {
    leaveAlone.legacyClosed += 1;
  }
}

console.log(`Lines currently marked FULFILLED: ${(lines ?? []).length}`);
console.log(`  -> will be reset to APPROVED      : ${toCorrect.length}`);
console.log(`  -> legacy confirms closed, skipped: ${leaveAlone.legacyClosed}`);
console.log(`  -> no legacy match, skipped       : ${leaveAlone.noLegacyMatch}`);
console.log(`  -> no invoice number, skipped     : ${leaveAlone.noInvoice}`);

if (!APPLY) {
  console.log("\nPreview only. Re-run with --apply to write.");
  process.exit(0);
}

const backupPath = path.join(process.cwd(), "tmp", `backup-fulfilled-states-${Date.now()}.json`);
writeFileSync(backupPath, JSON.stringify(toCorrect, null, 2), "utf8");
console.log(`\nBackup of prior states: ${backupPath}`);

const ids = toCorrect.map((row) => row.id);
for (let index = 0; index < ids.length; index += 200) {
  const batch = ids.slice(index, index + 200);
  const { error } = await supabase
    .from("shipping_order_lines")
    .update({ approval_status: "APPROVED", warehouse_status: "APPROVED" })
    .in("id", batch);
  if (error) {
    console.error(`Failed on batch starting ${index}: ${error.message}`);
    process.exit(1);
  }
}

console.log(`Applied. ${ids.length} line(s) reset to APPROVED.`);
