#!/usr/bin/env node

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const REPORT_DIR = "tmp/import-reports";
const OUTPUT = `${REPORT_DIR}/aug7-inventory-evidence-audit.json`;
const MARKDOWN = `${REPORT_DIR}/aug7-inventory-evidence-audit.md`;
const CUTOFF = "2026-08-08T00:00:00.000Z";
const nonPhysical = /discount|shipping|freight|delivery|sales tax|tax adjustment|\bnote\b|\bservice\b|\binstall(?:ation)?\b/i;
const warranty = /warranty|\b10[ -]?year\b|\b5[ -]?year\b|\b2[ -]?year\b/i;
const number = (value) => Number(value ?? 0);
const upper = (value) => String(value ?? "").trim().toUpperCase();
const compact = (value) => upper(value).replace(/[^A-Z0-9]/g, "");
const canonicalKey = (value) => {
  const full = compact(value);
  const stripped = compact(String(value ?? "").replace(/^(HL|HK|FB|YZ)-/i, ""));
  return !stripped || stripped === "AR1" ? full : stripped;
};

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing Supabase credentials. Run with node --env-file=.env.local.");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

const [products, aliases, transactions, lines, fulfillments, shipmentLines, allocations, containerLines] = await Promise.all([
  loadAll("products", "id,sku,canonical_name,status"),
  loadAll("product_aliases", "product_id,alias,source_type,source_ref"),
  loadAll("inventory_transactions", "id,product_id,bucket,delta,before_qty,after_qty,reason,source_type,source_event_key,container_id,shipping_order_line_id,created_at"),
  loadAll("shipping_order_lines", "id,product_id,approved_qty,fulfilled_qty,fulfillment_status,fulfillment_source,legacy_item_code,shipping_orders(order_number,legacy_customer_name,qbo_invoices(invoice_number,customers(company_name,full_name)))"),
  loadAll("fulfillments", "id,shipping_order_line_id,fulfilled_qty,fulfilled_at,shipment_number,tracking_number,source_event_key"),
  loadAll("order_shipment_lines", "id,shipping_order_line_id,quantity,shipment_id,order_shipments(shipment_number,shipped_at,carrier,tracking_number)"),
  loadAll("inventory_allocations", "id,shipping_order_line_id,product_id,container_id,quantity,allocation_status,source_type"),
  loadAll("container_lines", "id,product_id,container_id,on_order_qty,received_qty,containers(container_number,lifecycle_status)"),
]);

const aliasesByProduct = new Map();
for (const alias of aliases) if (alias.product_id && alias.alias) aliasesByProduct.set(alias.product_id, [...(aliasesByProduct.get(alias.product_id) ?? []), alias.alias]);
const transactionsByProduct = new Map();
for (const transaction of transactions) if (transaction.product_id) transactionsByProduct.set(transaction.product_id, [...(transactionsByProduct.get(transaction.product_id) ?? []), transaction]);
const productById = new Map(products.map((product) => [product.id, product]));
const lineById = new Map(lines.map((line) => [line.id, line]));
const fulfillmentsByLine = new Map();
for (const row of fulfillments) fulfillmentsByLine.set(row.shipping_order_line_id, [...(fulfillmentsByLine.get(row.shipping_order_line_id) ?? []), row]);
const shipmentsByLine = new Map();
for (const row of shipmentLines) shipmentsByLine.set(row.shipping_order_line_id, [...(shipmentsByLine.get(row.shipping_order_line_id) ?? []), row]);
const deductionsByLine = new Map();
for (const transaction of transactions.filter((row) => row.bucket === "ON_FLOOR" && row.shipping_order_line_id && number(row.delta) < 0 && !String(row.source_event_key ?? "").startsWith("OLD_ERP_OPENING"))) deductionsByLine.set(transaction.shipping_order_line_id, [...(deductionsByLine.get(transaction.shipping_order_line_id) ?? []), transaction]);

function productClass(product, identityTransactions, identityLines, identityContainers) {
  const text = [product.sku, product.canonical_name, ...(aliasesByProduct.get(product.id) ?? [])].join(" ");
  const hasPhysicalEvidence = identityTransactions.some((row) => row.bucket === "ON_FLOOR") || identityContainers.length > 0;
  if (/\btest\b/i.test(text)) return "TEST_DATA";
  if (String(product.status ?? "").toUpperCase() === "REMOVED") return "DELETED_LEGACY";
  if (hasPhysicalEvidence) return "PHYSICAL_LEDGER_CANDIDATE";
  if (nonPhysical.test(text)) return "NON_INVENTORY_SERVICE";
  if (warranty.test(text)) return "WARRANTY";
  if (identityLines.some((row) => row.product_id === product.id)) return "PHYSICAL_CANDIDATE_WITHOUT_LEDGER";
  return "UNKNOWN_NEEDS_REVIEW";
}

const catalog = products.map((product) => {
  const identityTransactions = transactionsByProduct.get(product.id) ?? [];
  const identityLines = lines.filter((line) => line.product_id === product.id);
  const identityContainers = containerLines.filter((line) => line.product_id === product.id);
  const onFloorTransactions = identityTransactions.filter((row) => row.bucket === "ON_FLOOR");
  const opening = onFloorTransactions.filter((row) => row.source_type === "RECOUNT" && String(row.source_event_key ?? "").startsWith("OLD_ERP_OPENING"));
  const currentOnFloor = onFloorTransactions.reduce((sum, row) => sum + number(row.delta), 0);
  const preferred = (aliasesByProduct.get(product.id) ?? []).find((alias) => alias && !/^\d+$/.test(alias)) ?? product.sku;
  return {
    canonicalSku: canonicalKey(preferred), productId: product.id, storedSku: product.sku, canonicalName: product.canonical_name, status: product.status,
    aliases: aliasesByProduct.get(product.id) ?? [], classification: productClass(product, identityTransactions, identityLines, identityContainers), currentOnFloor,
    onFloorSourceTypes: Object.fromEntries(Object.entries(Object.groupBy(onFloorTransactions, (row) => row.source_type)).map(([type, rows]) => [type, rows.reduce((sum, row) => sum + number(row.delta), 0)])),
    openingEvidence: opening.map((row) => ({ id: row.id, date: row.created_at, before: number(row.before_qty), after: number(row.after_qty), delta: number(row.delta), sourceType: row.source_type, sourceEventKey: row.source_event_key, reason: row.reason, reliability: row.created_at >= CUTOFF ? "POST_CUTOFF_MIGRATION_EVIDENCE_NOT_AUG7_COUNT" : "PRE_CUTOFF_LEDGER_EVIDENCE" })),
    postOpeningMovements: onFloorTransactions.filter((row) => !String(row.source_event_key ?? "").startsWith("OLD_ERP_OPENING")).map((row) => ({ id: row.id, date: row.created_at, delta: number(row.delta), sourceType: row.source_type, sourceEventKey: row.source_event_key, reason: row.reason, containerId: row.container_id, lineId: row.shipping_order_line_id })),
  };
});
const catalogByKey = new Map();
for (const row of catalog) catalogByKey.set(row.canonicalSku, [...(catalogByKey.get(row.canonicalSku) ?? []), row]);
const onFloor = [...catalogByKey.entries()].map(([sku, identities]) => ({
  canonicalSku: sku, currentOnFloor: identities.reduce((sum, row) => sum + row.currentOnFloor, 0), productIds: identities.map((row) => row.productId),
  classifications: [...new Set(identities.map((row) => row.classification))], identities,
})).filter((row) => row.currentOnFloor !== 0).sort((left, right) => right.currentOnFloor - left.currentOnFloor || left.canonicalSku.localeCompare(right.canonicalSku));
const usableOnFloor = onFloor.filter((row) => !row.classifications.includes("TEST_DATA"));

const shipmentAudits = [];
for (const line of lines) {
  const fulfilled = number(line.fulfilled_qty);
  const fulfillmentEvidence = (fulfillmentsByLine.get(line.id) ?? []).reduce((sum, row) => sum + number(row.fulfilled_qty), 0);
  const shipmentEvidence = (shipmentsByLine.get(line.id) ?? []).reduce((sum, row) => sum + number(row.quantity), 0);
  const source = upper(line.fulfillment_source);
  const physical = fulfilled > 0 && !["DROPSHIP", "OTHER"].includes(source);
  if (!physical) continue;
  const expected = Math.min(fulfilled, Math.max(fulfillmentEvidence, shipmentEvidence));
  const deductions = deductionsByLine.get(line.id) ?? [];
  const deducted = deductions.reduce((sum, row) => sum + Math.max(0, -number(row.delta)), 0);
  const product = productById.get(line.product_id);
  const customer = line.shipping_orders?.qbo_invoices?.customers?.company_name ?? line.shipping_orders?.qbo_invoices?.customers?.full_name ?? line.shipping_orders?.legacy_customer_name ?? null;
  const invoice = line.shipping_orders?.qbo_invoices?.invoice_number ?? line.shipping_orders?.order_number ?? null;
  const exceptions = [];
  if (expected === 0) exceptions.push("FULFILLED_WITHOUT_SHIPMENT_OR_FULFILLMENT_EVIDENCE");
  if (deducted < expected) exceptions.push("MISSING_PHYSICAL_DEDUCTION");
  if (deducted > expected) exceptions.push("DUPLICATE_OR_EXCESS_DEDUCTION");
  if (fulfillmentEvidence > 0 && shipmentEvidence > 0 && fulfillmentEvidence !== shipmentEvidence) exceptions.push("SHIPMENT_FULFILLMENT_QUANTITY_MISMATCH");
  shipmentAudits.push({ lineId: line.id, invoice, customer, productId: line.product_id, sku: canonicalKey(product?.sku ?? line.legacy_item_code), fulfilled, fulfillmentEvidence, shipmentEvidence, expectedPhysicalShipment: expected, physicalDeduction: deducted, exceptions, deductions: deductions.map((row) => ({ id: row.id, date: row.created_at, delta: number(row.delta), sourceType: row.source_type, sourceEventKey: row.source_event_key })) });
}
const deductionsWithoutShipment = transactions.filter((row) => row.bucket === "ON_FLOOR" && number(row.delta) < 0 && row.shipping_order_line_id && !String(row.source_event_key ?? "").startsWith("OLD_ERP_OPENING") && !shipmentAudits.some((audit) => audit.lineId === row.shipping_order_line_id)).map((row) => ({ id: row.id, lineId: row.shipping_order_line_id, productId: row.product_id, delta: number(row.delta), sourceType: row.source_type, sourceEventKey: row.source_event_key, reason: row.reason }));
const shipmentExceptions = shipmentAudits.filter((audit) => audit.exceptions.length > 0);
const invoiceProductAudits = new Map();
for (const audit of shipmentAudits.filter((row) => row.expectedPhysicalShipment > 0)) {
  const key = `${audit.invoice ?? "UNKNOWN"}|${audit.productId}`;
  const aggregate = invoiceProductAudits.get(key) ?? { invoice: audit.invoice, customer: audit.customer, productId: audit.productId, sku: audit.sku, expectedPhysicalShipment: 0, physicalDeduction: 0, lineIds: [], lineExceptions: [] };
  aggregate.expectedPhysicalShipment += audit.expectedPhysicalShipment;
  aggregate.physicalDeduction += audit.physicalDeduction;
  aggregate.lineIds.push(audit.lineId);
  if (audit.exceptions.length) aggregate.lineExceptions.push({ lineId: audit.lineId, exceptions: audit.exceptions });
  invoiceProductAudits.set(key, aggregate);
}
const invoiceLevelExceptions = [...invoiceProductAudits.values()].map((audit) => ({
  ...audit,
  unresolvedUnits: Math.max(0, audit.expectedPhysicalShipment - audit.physicalDeduction),
  classification: audit.physicalDeduction === audit.expectedPhysicalShipment
    ? "LINE_LINKAGE_MISSING_INVOICE_RECONCILED"
    : audit.physicalDeduction < audit.expectedPhysicalShipment
      ? "INVOICE_LEVEL_MISSING_PHYSICAL_DEDUCTION"
      : "INVOICE_LEVEL_DUPLICATE_OR_EXCESS_DEDUCTION",
})).filter((audit) => audit.lineExceptions.length > 0).sort((left, right) => right.unresolvedUnits - left.unresolvedUnits || String(left.invoice).localeCompare(String(right.invoice)) || left.productId.localeCompare(right.productId));
const report = {
  generatedAt: new Date().toISOString(), readOnly: true, cutoff: CUTOFF,
  methodology: "Current ON_FLOOR is summed only from inventory_transactions.bucket=ON_FLOOR. Shipment conservation matches fulfilled physical lines to linked ON_FLOOR deductions by shipping_order_line_id; dropship and other fulfillments are inventory-neutral.",
  catalogSummary: Object.fromEntries(Object.entries(Object.groupBy(catalog, (row) => row.classification)).map(([classification, rows]) => [classification, rows.length])),
  onFloorSummary: { identitiesWithNonzeroOnFloor: onFloor.length, currentOnFloorIncludingTestData: onFloor.reduce((sum, row) => sum + row.currentOnFloor, 0), currentOnFloorExcludingTestData: usableOnFloor.reduce((sum, row) => sum + row.currentOnFloor, 0), abnormalOver100: onFloor.filter((row) => Math.abs(row.currentOnFloor) > 100).map((row) => ({ sku: row.canonicalSku, onFloor: row.currentOnFloor, classifications: row.classifications, productIds: row.productIds, interpretation: row.classifications.includes("TEST_DATA") ? "EXCLUDE_FROM_OPERATIONAL_RECONCILIATION" : "REQUIRES_SOURCE_COUNT_CORROBORATION" })) },
  shipmentSummary: { shipmentLinesAudited: shipmentAudits.length, shippedUnits: shipmentAudits.reduce((sum, row) => sum + row.expectedPhysicalShipment, 0), matchedDeductions: shipmentAudits.reduce((sum, row) => sum + Math.min(row.expectedPhysicalShipment, row.physicalDeduction), 0), missingDeductions: shipmentAudits.filter((row) => row.exceptions.includes("MISSING_PHYSICAL_DEDUCTION")).reduce((sum, row) => sum + Math.max(0, row.expectedPhysicalShipment - row.physicalDeduction), 0), invoiceLevelUnresolvedUnits: invoiceLevelExceptions.filter((row) => row.classification === "INVOICE_LEVEL_MISSING_PHYSICAL_DEDUCTION").reduce((sum, row) => sum + row.unresolvedUnits, 0), lineLinkageGapsReconciledAtInvoiceLevel: invoiceLevelExceptions.filter((row) => row.classification === "LINE_LINKAGE_MISSING_INVOICE_RECONCILED").length, duplicateDeductions: shipmentAudits.filter((row) => row.exceptions.includes("DUPLICATE_OR_EXCESS_DEDUCTION")).reduce((sum, row) => sum + Math.max(0, row.physicalDeduction - row.expectedPhysicalShipment), 0), quantityMismatches: shipmentAudits.filter((row) => row.exceptions.length > 0).length, deductionsWithoutShipment: deductionsWithoutShipment.length },
  currentOnFloorDescending: onFloor, shipmentExceptions, invoiceLevelExceptions, deductionsWithoutShipment,
};
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
const markdown = ["# August 7 Inventory Evidence Audit", "", "Read-only. No production data was modified. OLD_ERP opening events posted after August 8 are migration evidence, not proof of an August 7 physical count.", "", "## Shipment Conservation", "", ...Object.entries(report.shipmentSummary).map(([name, value]) => `- ${name}: ${value}`), "", "## Invoice-Level Exceptions", "", "| Invoice | Customer | SKU | Expected shipment | Physical deduction | Unresolved units | Classification |", "|---|---|---|---:|---:|---:|---|", ...invoiceLevelExceptions.map((row) => `| ${row.invoice ?? "-"} | ${row.customer ?? "-"} | ${row.sku} | ${row.expectedPhysicalShipment} | ${row.physicalDeduction} | ${row.unresolvedUnits} | ${row.classification} |`), "", "## Current ON_FLOOR Descending", "", "| Canonical SKU | Current ON_FLOOR | Product IDs | Classification | Opening evidence | Post-opening movements |", "|---|---:|---|---|---|---:|", ...onFloor.map((row) => `| ${row.canonicalSku} | ${row.currentOnFloor} | ${row.productIds.join(", ")} | ${row.classifications.join(", ")} | ${row.identities.reduce((sum, identity) => sum + identity.openingEvidence.length, 0)} events | ${row.identities.reduce((sum, identity) => sum + identity.postOpeningMovements.length, 0)} |`), "", "## Shipment Exceptions", "", "| Invoice | Customer | SKU | Expected shipment | Physical deduction | Exception |", "|---|---|---|---:|---:|---|", ...shipmentExceptions.map((row) => `| ${row.invoice ?? "-"} | ${row.customer ?? "-"} | ${row.sku} | ${row.expectedPhysicalShipment} | ${row.physicalDeduction} | ${row.exceptions.join(", ")} |`)];
fs.writeFileSync(MARKDOWN, `${markdown.join("\n")}\n`);
console.log(JSON.stringify({ readOnly: true, report: OUTPUT, markdown: MARKDOWN, catalogSummary: report.catalogSummary, onFloorSummary: report.onFloorSummary, shipmentSummary: report.shipmentSummary, shipmentExceptions: shipmentExceptions.slice(0, 25) }, null, 2));