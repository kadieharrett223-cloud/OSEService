#!/usr/bin/env node

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const manifest = JSON.parse(fs.readFileSync("tmp/import-reports/ready-to-apply-manifest.json", "utf8"));
const source = JSON.parse(fs.readFileSync("tmp/exports/azure-InvoiceQueueItems-2026-08-14T17-02-42-562Z.json", "utf8"));
const mapping = JSON.parse(fs.readFileSync("tmp/import-reports/ambiguous-product-mapping-report.json", "utf8"));
const sourceRows = Array.isArray(source) ? source : source.records ?? source.items ?? source.data ?? [];
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const normalize = value => String(value ?? "").trim().toUpperCase();
const compact = value => normalize(value).replace(/[^A-Z0-9]/g, "");
const invoiceOf = row => normalize(row.invoiceNumber ?? row.invoice_number ?? row.orderNumber);
const sourceSkuOf = row => normalize(row.matchedItemCode ?? row.matched_item_code ?? row.matchedSku ?? row.itemCode ?? row.item_code ?? row.sku ?? row.partNumber);
const qtyOf = row => Number(row.qty ?? row.approvedQty ?? row.orderedQty ?? row.quantity ?? 0);
const customerOf = row => row.customerName ?? row.customer_name ?? row.companyName ?? row.customer ?? null;
const sourceOpen = row => normalize(row.approvalStatus ?? row.approval_status) === "APPROVED" && !row.removed && !row.fulfilledAt && !["FULFILLED", "REMOVED", "DENIED", "CANCELLED", "CANCELED"].includes(normalize(row.queueStatus ?? row.queue_status ?? row.status)) && qtyOf(row) > 0;
const remaining = row => Math.max(0, Number(row.approved_qty ?? row.ordered_qty ?? 0) - Number(row.fulfilled_qty ?? 0));
const heldSkus = new Set(["HLCJ-6", "JVCJ-6", "000185", "10000006", "HPU1103", "2PCFHD-12"]);
const heldInvoices = new Set(["126037"]);
const survivorBySourceSku = new Map(mapping.survivorProposals.filter(row => row.survivorProductId).map(row => [row.sourceSku, row.survivorProductId]));
const [{ data: products, error: productError }, { data: orders, error: orderError }, { data: lines, error: lineError }, { data: activities, error: activityError }] = await Promise.all([
  db.from("products").select("id,sku,canonical_name"),
  db.from("shipping_orders").select("id,order_number,source_system,source_key,created_at,legacy_customer_name,customers(company_name,full_name),qbo_invoices(invoice_number)"),
  db.from("shipping_order_lines").select("id,shipping_order_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,warehouse_status,fulfillment_status,priority,queue_position_start,queue_position_override,queue_position_override_reason,created_at,products(sku),shipping_orders(order_number,source_system,created_at)"),
  db.from("audit_log").select("entity_id,action,details,created_at").eq("entity_type", "shipping_order"),
]);
for (const error of [productError, orderError, lineError, activityError]) if (error) throw new Error(error.message);
const productIdBySku = new Map();
for (const product of products ?? []) { productIdBySku.set(normalize(product.sku), product.id); productIdBySku.set(compact(product.sku), product.id); }
const canonicalForSource = rawSku => { const key = normalize(rawSku); const proposed = survivorBySourceSku.get(key) ?? survivorBySourceSku.get(compact(key)); if (proposed) return products?.find(row => row.id === proposed)?.sku ?? key; const id = productIdBySku.get(key) ?? productIdBySku.get(compact(key)); return products?.find(row => row.id === id)?.sku ?? key; };
const sourceByInvoiceSku = new Map();
for (const row of sourceRows.filter(sourceOpen)) { const invoice = invoiceOf(row); const canonicalSku = canonicalForSource(sourceSkuOf(row)); if (!invoice || !canonicalSku || heldInvoices.has(invoice) || heldSkus.has(sourceSkuOf(row)) || heldSkus.has(canonicalSku)) continue; const key = `${invoice}|${canonicalSku}`; const entry = sourceByInvoiceSku.get(key) ?? { invoice, canonicalSku, qty: 0, rows: [] }; entry.qty += qtyOf(row); entry.rows.push(row); sourceByInvoiceSku.set(key, entry); }
const orderById = new Map((orders ?? []).map(row => [row.id, row]));
const orderByInvoiceSource = new Map();
for (const order of orders ?? []) { const invoice = normalize(order.qbo_invoices?.invoice_number ?? order.order_number); if (invoice) orderByInvoiceSource.set(`${invoice}|${order.source_system === "OLD_ERP" ? "OLD_ERP" : "QBO_INVOICE"}`, [...(orderByInvoiceSource.get(`${invoice}|${order.source_system === "OLD_ERP" ? "OLD_ERP" : "QBO_INVOICE"}`) ?? []), order]); }
const linesByOrder = new Map();
for (const line of lines ?? []) linesByOrder.set(line.shipping_order_id, [...(linesByOrder.get(line.shipping_order_id) ?? []), line]);
const activityByOrder = new Map();
for (const row of activities ?? []) activityByOrder.set(row.entity_id, [...(activityByOrder.get(row.entity_id) ?? []), row]);
const lineSku = line => canonicalForSource(line.products?.sku);
const lineFor = (orderId, sku) => (linesByOrder.get(orderId) ?? []).filter(line => lineSku(line) === sku && remaining(line) > 0);
const operationalActivity = orderId => (activityByOrder.get(orderId) ?? []).filter(row => ["ORDER_NOTE_ADDED", "ORDER_SCHEDULE_UPDATED"].includes(row.action));
const proof = [];
for (const row of manifest.readyRows) {
  const invoice = normalize(row.invoice);
  const sku = normalize(row.sku);
  let status = "READY";
  let reason = "Traceable to current Cosmos source and live survivor order.";
  if (heldInvoices.has(invoice) || heldSkus.has(sku)) { status = "BLOCKED"; reason = "Held manual mapping or invoice 126037."; }
  const sourceEntry = sourceByInvoiceSku.get(`${invoice}|${sku}`);
  const survivor = orderById.get(row.orderId) ?? orderByInvoiceSource.get(`${invoice}|${row.survivingSource === "OLD_ERP" ? "OLD_ERP" : "QBO_INVOICE"}`)?.[0];
  const survivorLines = survivor ? lineFor(survivor.id, sku) : [];
  const duplicateOrders = orderByInvoiceSource.get(`${invoice}|OLD_ERP`) ?? [];
  const qboOrders = orderByInvoiceSource.get(`${invoice}|QBO_INVOICE`) ?? [];
  if (!sourceEntry && row.action !== "REMOVE_STALE_OLD_ERP_LINE") { status = "BLOCKED"; reason = "No current approved/unfulfilled Cosmos source row for normalized invoice and canonical SKU."; }
  if (!survivor) { status = "BLOCKED"; reason = "No surviving ERP order could be traced by normalized invoice."; }
  if (row.action === "REMOVE_DUPLICATE_OLD_ERP_ORDER") {
    if (!qboOrders.length) { status = "BLOCKED"; reason = "No matching QBO survivor exists."; }
    const oldOrder = duplicateOrders[0];
    if (!oldOrder) { status = "BLOCKED"; reason = "No OLD_ERP duplicate order exists."; }
    if (oldOrder && operationalActivity(oldOrder.id).length) { status = "BLOCKED"; reason = "OLD_ERP duplicate contains staff notes or schedule activity."; }
    if (sourceEntry && qboOrders.length) { const qboQty = lineFor(qboOrders[0].id, sku).reduce((sum, line) => sum + remaining(line), 0); if (qboQty < sourceEntry.qty) { status = "BLOCKED"; reason = "QBO survivor does not represent all current Cosmos quantity."; } }
  }
  if (row.action === "REMOVE_STALE_OLD_ERP_LINE") {
    const oldOrder = duplicateOrders.find(order => order.id === row.orderId) ?? duplicateOrders[0];
    const currentCosmos = sourceEntry?.qty ?? 0;
    const qboQty = qboOrders.flatMap(order => lineFor(order.id, sku)).reduce((sum, line) => sum + remaining(line), 0);
    if (currentCosmos > 0) { status = "BLOCKED"; reason = "Current approved/unfulfilled Cosmos obligation still exists."; }
    if (qboQty > 0) { status = "BLOCKED"; reason = "Newer/current QBO demand exists for this invoice and SKU."; }
    if (!oldOrder) { status = "BLOCKED"; reason = "No OLD_ERP source order/line could be traced."; }
  }
  const customer = survivor?.customers?.company_name ?? survivor?.customers?.full_name ?? survivor?.legacy_customer_name ?? (sourceEntry?.rows?.[0] ? customerOf(sourceEntry.rows[0]) : null);
  proof.push({ ...row, normalizedInvoice: invoice, customer, canonicalSku: sku, cosmosSourceRows: sourceEntry?.rows?.map(source => ({ sourceRecordId: source.id ?? source._id ?? source.recordId ?? null, sourceKey: `OLD_ERP_BACKLOG_LINE:${source.id ?? source._id ?? source.recordId ?? "unknown"}`, qty: qtyOf(source), approvalStatus: source.approvalStatus, queueStatus: source.queueStatus, removed: source.removed ?? false, fulfilledAt: source.fulfilledAt ?? null })) ?? [], survivingOrder: survivor ? { id: survivor.id, source: survivor.source_system === "OLD_ERP" ? "OLD_ERP" : "QBO_INVOICE", sourceKey: survivor.source_key ?? null, createdAt: survivor.created_at } : null, currentErpLines: survivorLines.map(line => ({ id: line.id, productId: line.product_id, sku: lineSku(line), remainingQty: remaining(line), approvedQty: line.approved_qty, fulfilledQty: line.fulfilled_qty, warehouseStatus: line.warehouse_status, queuePosition: line.queue_position_start })), operationalActivity: survivor ? operationalActivity(survivor.id).map(activity => activity.action) : [], proofStatus: status, safetyReason: reason });
}
const ready = proof.filter(row => row.proofStatus === "READY");
const blocked = proof.filter(row => row.proofStatus === "BLOCKED");
const uniqueInvoices = new Set(ready.map(row => row.normalizedInvoice));
const actionCounts = Object.fromEntries([...new Set(ready.map(row => row.action))].map(action => [action, ready.filter(row => row.action === action).length]));
const report = { generatedAt: new Date().toISOString(), readOnly: true, sourceManifestRows: manifest.readyRows.length, readyRows: ready, blockedRows: blocked, summary: { sourceManifestRows: manifest.readyRows.length, readyRows: ready.length, blockedRows: blocked.length, uniqueReadyInvoices: uniqueInvoices.size, actionCounts, heldInvoiceExcluded: heldInvoices.has("126037"), heldSkusExcluded: [...heldSkus] } };
fs.writeFileSync("tmp/import-reports/ready-manifest-reconciliation.json", JSON.stringify(report, null, 2));
fs.writeFileSync("tmp/import-reports/reconciled-ready-to-apply-manifest.json", JSON.stringify({ generatedAt: report.generatedAt, readOnly: true, applyExecuted: false, readyRows: ready, summary: report.summary }, null, 2));
const markdown = [`# Ready Manifest Reconciliation (Read-Only)`, ``, `No apply, deletes, aliases, or order-line updates were executed.`, ``, `- Source manifest rows: ${report.summary.sourceManifestRows}`, `- Fully traceable ready rows: ${report.summary.readyRows}`, `- Blocked rows removed from reconciled-ready set: ${report.summary.blockedRows}`, `- Unique ready invoices: ${report.summary.uniqueReadyInvoices}`, `- 126037 excluded: ${report.summary.heldInvoiceExcluded}`, ``, `## Action Counts`, ``, ...Object.entries(actionCounts).map(([action, count]) => `- ${action}: ${count}`), ``, `## 55 PASS Expansion`, ``, `The source validation contains 55 simulated PASS SKU groups after the five stale OLD_ERP repairs. The manifest expands those groups into invoice/SKU database operations. Every ready row below includes its normalized invoice, customer, canonical SKU, Cosmos source row/key, surviving order, current line, action, and safety reason.`, ``, `## Blocked Rows`, ``, ...blocked.map(row => `- ${row.normalizedInvoice} | ${row.sku} | ${row.action} | ${row.safetyReason}`)];
fs.writeFileSync("tmp/import-reports/ready-manifest-reconciliation.md", `${markdown.join("\n")}\n`);
const readyMarkdown = ["# Reconciled Ready-to-Apply Manifest (Read-Only)", "", "Only fully traceable rows are included. Apply was not executed.", "", "| Invoice | Customer | Order ID | Source | SKU | Qty | Action | Safety reason |", "|---|---|---|---|---|---:|---|---|"];
for (const row of ready) readyMarkdown.push(`| ${row.normalizedInvoice} | ${row.customer ?? "—"} | ${row.orderId ?? "—"} | ${row.survivingSource} | ${row.canonicalSku ?? "—"} | ${row.qty ?? 0} | ${row.action} | ${row.safetyReason} |`);
readyMarkdown.push("", `Ready rows: ${ready.length}`, `Blocked rows removed: ${blocked.length}`, `Unique invoices: ${uniqueInvoices.size}`, "Apply remains blocked until the blocked rows are resolved.");
fs.writeFileSync("tmp/import-reports/reconciled-ready-to-apply-manifest.md", `${readyMarkdown.join("\n")}\n`);
console.log(JSON.stringify({ report: "tmp/import-reports/ready-manifest-reconciliation.json", markdown: "tmp/import-reports/ready-manifest-reconciliation.md", reconciledJson: "tmp/import-reports/reconciled-ready-to-apply-manifest.json", reconciledMarkdown: "tmp/import-reports/reconciled-ready-to-apply-manifest.md", summary: report.summary }, null, 2));
