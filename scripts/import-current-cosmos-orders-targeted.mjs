#!/usr/bin/env node
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
if (!APPLY) throw new Error("This targeted current-order importer requires --apply.");
const source = JSON.parse(fs.readFileSync("tmp/exports/azure-InvoiceQueueItems-2026-08-14T17-02-42-562Z.json", "utf8"));
const rawRows = Array.isArray(source) ? source : source.records ?? source.items ?? source.data ?? [];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const normalize = value => String(value ?? "").trim().toUpperCase();
const compact = value => normalize(value).replace(/[^A-Z0-9]/g, "");
const text = value => { const result = String(value ?? "").trim(); return result || null; };
const invoiceOf = row => { const raw = text(row.invoiceNumber ?? row.invoice_number ?? row.orderNumber ?? row.qbo_invoices?.invoice_number); if (!raw) return null; const numeric = Number(raw); return Number.isFinite(numeric) ? String(numeric) : normalize(raw); };
const customerOf = row => text(row.customerName ?? row.customer_name ?? row.companyName ?? row.customer);
const sourceSkuOf = row => normalize(row.matchedItemCode ?? row.matched_item_code ?? row.matchedSku ?? row.itemCode ?? row.item_code ?? row.sku ?? row.partNumber);
const qtyOf = row => Number(row.qty ?? row.approvedQty ?? row.orderedQty ?? row.quantity ?? 0);
const sourceIdOf = row => text(row.id ?? row._id ?? row.recordId ?? row.lineId ?? row.queueLineId);
const sourceTime = row => Date.parse(String(row.updatedAt ?? row.updated_at ?? row.createdAt ?? row.created_at ?? row.approvedAt ?? row.approved_at ?? "")) || 0;
const current = row => normalize(row.approvalStatus ?? row.approval_status) === "APPROVED" && !row.removed && !row.fulfilledAt && !["FULFILLED", "REMOVED", "DENIED", "CANCELLED", "CANCELED"].includes(normalize(row.queueStatus ?? row.queue_status ?? row.status)) && qtyOf(row) > 0;
const heldSkus = new Set(["HLCJ-6", "JVCJ-6", "220V", "HPU2204", "4PHDXLA-14", "APU", "YZ-ARJT", "000185", "10000006", "HPU1103", "2PCFHD-12"]);
const heldInvoice = "126037";
const result = { sourceRows: rawRows.length, currentInvoicesProcessed: 0, existingQboUpdated: 0, existingOldErpUpdated: 0, newOldErpCreated: 0, linesImportedOrUpdated: 0, heldManualExceptions: 52, activeProducts: new Set(), errors: [], createdLines: [], updatedLines: [] };
async function tableColumns(table, candidates) {
  const found = new Set();
  for (const candidate of candidates) { const { error } = await db.from(table).select(candidate).limit(1); if (!error) found.add(candidate); }
  return found;
}
const [{ data: products, error: pe }, { data: aliases, error: ae }, { data: qboInvoices, error: qe }, { data: orders, error: oe }, { data: lines, error: le }, { data: manual, error: me }] = await Promise.all([
  db.from("products").select("id,sku"),
  db.from("product_aliases").select("product_id,alias"),
  db.from("qbo_invoices").select("id,invoice_number,customer_id"),
  db.from("shipping_orders").select("id,order_number,source_system,source_key,source_record_id,source_invoice_id,source_type,customer_id,legacy_customer_name,review_status,qbo_invoices(invoice_number)"),
  db.from("shipping_order_lines").select("id,shipping_order_id,product_id,source_system,source_record_id,source_key,qbo_invoice_line_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,warehouse_status,fulfillment_status,priority,legacy_item_code,queue_position_override,queue_position_override_reason"),
  db.from("manual_product_mapping_queue").select("source_sku,status").eq("status", "OPEN"),
]);
for (const error of [pe, ae, qe, oe, le, me]) if (error) throw new Error(error.message);
const orderColumns = await tableColumns("shipping_orders", ["customer_id", "source_invoice_id", "order_number", "source_type", "review_status", "fulfillment_status", "priority", "legacy_customer_name", "source_system", "source_record_id", "source_key"]);
const filterOrder = payload => Object.fromEntries(Object.entries(payload).filter(([key]) => orderColumns.has(key)));
const held = new Set([...(manual ?? []).map(row => normalize(row.source_sku)), ...heldSkus]);
const productIdsBySku = new Map();
const addMapping = (key, id) => { if (!key || !id) return; productIdsBySku.set(key, new Set([...(productIdsBySku.get(key) ?? []), id])); };
for (const product of products ?? []) { addMapping(normalize(product.sku), product.id); addMapping(compact(product.sku), product.id); }
for (const alias of aliases ?? []) { addMapping(normalize(alias.alias), alias.product_id); addMapping(compact(alias.alias), alias.product_id); }
const proposed = new Map();
try { const proposal = JSON.parse(fs.readFileSync("tmp/import-reports/ambiguous-product-mapping-report.json", "utf8")); for (const row of proposal.survivorProposals ?? []) if (row.survivorProductId) proposed.set(normalize(row.sourceSku), row.survivorProductId); } catch {}
const resolveProduct = sku => { if (held.has(normalize(sku))) return null; const proposedId = proposed.get(normalize(sku)); if (proposedId) return proposedId; const candidates = productIdsBySku.get(normalize(sku)) ?? productIdsBySku.get(compact(sku)); return candidates?.size === 1 ? [...candidates][0] : null; };
const qboByInvoice = new Map(); for (const invoice of qboInvoices ?? []) { const key = invoiceOf(invoice); if (key) qboByInvoice.set(key, invoice); }
const ordersByInvoice = new Map(); for (const order of orders ?? []) { const key = invoiceOf(order); if (key) ordersByInvoice.set(key, [...(ordersByInvoice.get(key) ?? []), order]); }
const lineBySourceKey = new Map((lines ?? []).filter(row => row.source_key).map(row => [row.source_key, row]));
const lineByOrderProduct = new Map((lines ?? []).map(row => [`${row.shipping_order_id}|${row.product_id}`, row]));
const grouped = new Map();
for (const row of rawRows.filter(current)) { const invoice = invoiceOf(row); const sku = sourceSkuOf(row); const productId = resolveProduct(sku); if (!invoice || heldInvoice === invoice || !productId) continue; const key = `${invoice}|${sku}|${productId}`; const existing = grouped.get(key); if (!existing || sourceTime(row) > sourceTime(existing.raw)) grouped.set(key, { raw: row, invoice, sku, productId, customer: customerOf(row), qty: qtyOf(row), sourceId: sourceIdOf(row) }); }
const invoiceKeys = [...new Set([...grouped.values()].map(row => row.invoice))];
result.currentInvoicesProcessed = invoiceKeys.length;
const customerIdsByName = new Map();
for (const row of grouped.values()) { if (!row.customer || customerIdsByName.has(row.customer)) continue; const { data } = await db.from("customers").select("id").or(`company_name.ilike.${row.customer},full_name.ilike.${row.customer}`).limit(1); if (data?.[0]?.id) customerIdsByName.set(row.customer, data[0].id); }
for (const invoice of invoiceKeys) {
  const rows = [...grouped.values()].filter(row => row.invoice === invoice);
  let qboOrder = (ordersByInvoice.get(invoice) ?? []).find(order => order.source_system !== "OLD_ERP") ?? null;
  let oldOrder = (ordersByInvoice.get(invoice) ?? []).find(order => order.source_system === "OLD_ERP") ?? null;
  let order = qboOrder ?? oldOrder;
  if (!order) {
    const qbo = qboByInvoice.get(invoice);
    const first = rows[0];
    const inserted = await db.from("shipping_orders").insert(filterOrder({ customer_id: qbo?.customer_id ?? customerIdsByName.get(first.customer) ?? null, source_invoice_id: qbo?.id ?? null, order_number: invoice, source_type: qbo ? "QBO_INVOICE" : "INTERNAL", review_status: "APPROVED", fulfillment_status: "PENDING", priority: "NORMAL", legacy_customer_name: first.customer, source_system: qbo ? null : "OLD_ERP", source_record_id: qbo ? null : invoice, source_key: qbo ? null : `OLD_ERP_BACKLOG_ORDER:${invoice}` })).select("id,source_system").single();
    if (inserted.error) { result.errors.push({ invoice, error: inserted.error.message }); continue; }
    order = inserted.data; if (qbo) result.existingQboUpdated += 1; else result.newOldErpCreated += 1;
  } else if (qboOrder) result.existingQboUpdated += 1; else result.existingOldErpUpdated += 1;
  for (const row of rows) {
    const sourceKey = `OLD_ERP_BACKLOG_LINE:${row.sourceId}`;
    let existing = lineBySourceKey.get(sourceKey) ?? lineByOrderProduct.get(`${order.id}|${row.productId}`);
    if (!existing) {
      const { data: sourceExisting, error: sourceLookupError } = await db.from("shipping_order_lines").select("id,shipping_order_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,warehouse_status,fulfillment_status,legacy_item_code").eq("source_key", sourceKey).maybeSingle();
      if (sourceLookupError) { result.errors.push({ invoice, sourceKey, error: sourceLookupError.message }); continue; }
      existing = sourceExisting;
    }
    const desired = row.qty;
    if (existing) {
      const fulfilled = Number(existing.fulfilled_qty ?? 0);
      const desiredApproved = Math.max(Number(existing.approved_qty ?? 0), fulfilled + desired);
      const payload = { ordered_qty: Math.max(Number(existing.ordered_qty ?? 0), desired), approved_qty: desiredApproved, legacy_item_code: existing.legacy_item_code ?? row.sku };
      if (existing.fulfillment_status === "FULFILLED" || existing.fulfillment_status === "PARTIALLY_FULFILLED" || fulfilled > 0) { delete payload.ordered_qty; delete payload.approved_qty; }
      const updated = await db.from("shipping_order_lines").update({ ...payload, shipping_order_id: order.id }).eq("id", existing.id);
      if (updated.error) { result.errors.push({ invoice, lineId: existing.id, error: updated.error.message }); continue; }
      result.linesImportedOrUpdated += 1; result.updatedLines.push({ invoice, lineId: existing.id, productId: row.productId, desiredQty: desired }); result.activeProducts.add(row.productId);
    } else {
      const inserted = await db.from("shipping_order_lines").insert({ shipping_order_id: order.id, product_id: row.productId, ordered_qty: desired, approved_qty: desired, fulfilled_qty: 0, cancelled_qty: 0, approval_status: "APPROVED", warehouse_status: "APPROVED", allocation_status: "UNALLOCATED", fulfillment_status: "PENDING", priority: "NORMAL", source_system: "OLD_ERP", source_record_id: row.sourceId, source_key: sourceKey, legacy_item_code: row.sku }).select("id").single();
      if (inserted.error) { result.errors.push({ invoice, error: inserted.error.message }); continue; }
      result.linesImportedOrUpdated += 1; result.createdLines.push({ invoice, lineId: inserted.data.id, productId: row.productId, desiredQty: desired }); result.activeProducts.add(row.productId);
    }
  }
}
const affected = [...result.activeProducts];
for (const productId of affected) {
  const { data: productLines, error } = await db.from("shipping_order_lines").select("id,product_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,priority,queue_position_override,shipping_orders(created_at)").eq("product_id", productId);
  if (error) { result.errors.push({ productId, error: error.message }); continue; }
  const active = (productLines ?? []).filter(row => ["APPROVED", "PARTIAL"].includes(normalize(row.approval_status)) && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(normalize(row.fulfillment_status)) && Number(row.approved_qty ?? 0) > Number(row.fulfilled_qty ?? 0)).sort((a,b) => Number(a.queue_position_override ?? 0) - Number(b.queue_position_override ?? 0) || String(a.shipping_orders?.created_at ?? "").localeCompare(String(b.shipping_orders?.created_at ?? "")) || a.id.localeCompare(b.id));
  let position = 1; for (const row of active) { const units = Math.max(0, Number(row.approved_qty ?? 0) - Number(row.fulfilled_qty ?? 0)); const update = await db.from("shipping_order_lines").update({ queue_position_start: position, queue_position_count: units }).eq("id", row.id); if (update.error) result.errors.push({ lineId: row.id, error: update.error.message }); position += units; }
}
const output = { ...result, activeProducts: affected, summary: { sourceRows: result.sourceRows, currentInvoicesProcessed: result.currentInvoicesProcessed, existingQboUpdated: result.existingQboUpdated, existingOldErpUpdated: result.existingOldErpUpdated, newOldErpCreated: result.newOldErpCreated, linesImportedOrUpdated: result.linesImportedOrUpdated, heldManualExceptions: 52, errors: result.errors.length } };
fs.writeFileSync("tmp/import-reports/current-cosmos-targeted-import-result.json", JSON.stringify(output, null, 2));
console.log(JSON.stringify(output.summary, null, 2));
