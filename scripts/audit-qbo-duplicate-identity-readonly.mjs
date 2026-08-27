import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const CUTOFF = "2026-08-07T00:00:00.000Z";
const PAID_STATUSES = new Set(["Paid", "Partially Paid"]);
const TERMINAL_FULFILLMENT_STATUSES = new Set(["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);
const ACTIVE_APPROVAL_STATUSES = new Set(["APPROVED", "PARTIAL"]);

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables. Use --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

function normalized(value) {
  return String(value ?? "").trim().toUpperCase();
}

function isPhysicalLine(line) {
  if (Number(line.ordered_qty ?? 0) <= 0) return false;
  const text = `${line.qbo_sku ?? ""} ${line.source_description ?? ""}`.toLowerCase();
  return !/^note\b|misc(?:ellaneous)?\s+charge\b|discount|shipping|freight|delivery|sales tax|tax adjustment|\bservice\b|\binstall(?:ation)?\b/.test(text);
}

function activeDemand(line) {
  const remaining = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
  return ACTIVE_APPROVAL_STATUSES.has(normalized(line.approval_status))
    && !TERMINAL_FULFILLMENT_STATUSES.has(normalized(line.fulfillment_status))
    && remaining > 0 ? remaining : 0;
}

const [invoices, invoiceLines, orders, orderLines] = await Promise.all([
  loadAll("qbo_invoices", "id,qbo_invoice_id,invoice_number,invoice_date,payment_status"),
  loadAll("qbo_invoice_lines", "id,qbo_invoice_id,qbo_line_id,qbo_sku,source_description,ordered_qty"),
  loadAll("shipping_orders", "id,source_invoice_id,source_type,source_system,duplicate_of_order_id,order_number"),
  loadAll("shipping_order_lines", "id,shipping_order_id,qbo_invoice_line_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status"),
]);

const candidateInvoices = invoices.filter((invoice) => PAID_STATUSES.has(invoice.payment_status) && invoice.invoice_date && Date.parse(invoice.invoice_date) >= Date.parse(CUTOFF));
const activeOrdersBySourceInvoice = new Map();
for (const order of orders) {
  if (!order.duplicate_of_order_id && order.source_invoice_id) {
    activeOrdersBySourceInvoice.set(order.source_invoice_id, [...(activeOrdersBySourceInvoice.get(order.source_invoice_id) ?? []), order]);
  }
}

const qboLinesByInvoice = new Map();
for (const line of invoiceLines) qboLinesByInvoice.set(line.qbo_invoice_id, [...(qboLinesByInvoice.get(line.qbo_invoice_id) ?? []), line]);
const erpLinesByQboLineId = new Map();
for (const line of orderLines) {
  if (line.qbo_invoice_line_id) erpLinesByQboLineId.set(line.qbo_invoice_line_id, [...(erpLinesByQboLineId.get(line.qbo_invoice_line_id) ?? []), line]);
}
const ordersById = new Map(orders.map((order) => [order.id, order]));

function representationEvidence(line) {
  return (erpLinesByQboLineId.get(line.id) ?? []).map((erpLine) => {
    const order = ordersById.get(erpLine.shipping_order_id);
    return {
      erpLineId: erpLine.id,
      erpOrderId: erpLine.shipping_order_id,
      erpOrderNumber: order?.order_number ?? null,
      erpSourceInvoiceId: order?.source_invoice_id ?? null,
      erpSourceType: order?.source_type ?? null,
      erpSourceSystem: order?.source_system ?? null,
      activeCustomerDemand: activeDemand(erpLine),
      fulfilledQuantity: Number(erpLine.fulfilled_qty ?? 0),
      fulfillmentStatus: erpLine.fulfillment_status ?? null,
    };
  });
}

const invoicesByPrintedNumber = new Map();
for (const invoice of invoices) {
  const invoiceNumber = normalized(invoice.invoice_number);
  if (invoiceNumber) invoicesByPrintedNumber.set(invoiceNumber, [...(invoicesByPrintedNumber.get(invoiceNumber) ?? []), invoice]);
}

const missingParents = candidateInvoices
  .filter((invoice) => (activeOrdersBySourceInvoice.get(invoice.id) ?? []).length === 0)
  .map((invoice) => ({ invoiceNumber: invoice.invoice_number, qboInvoiceId: invoice.qbo_invoice_id, qboInvoiceRowId: invoice.id }));
const duplicateParents = candidateInvoices
  .filter((invoice) => (activeOrdersBySourceInvoice.get(invoice.id) ?? []).length > 1)
  .map((invoice) => ({ invoiceNumber: invoice.invoice_number, qboInvoiceId: invoice.qbo_invoice_id, parents: (activeOrdersBySourceInvoice.get(invoice.id) ?? []).map((order) => ({ orderId: order.id, sourceType: order.source_type, sourceSystem: order.source_system, orderNumber: order.order_number })) }));
const physicalLines = candidateInvoices.flatMap((invoice) => (qboLinesByInvoice.get(invoice.id) ?? []).filter(isPhysicalLine).map((line) => ({ invoice, line })));
const missingPhysicalLines = physicalLines
  .filter(({ line }) => (erpLinesByQboLineId.get(line.id) ?? []).length === 0)
  .map(({ invoice, line }) => ({ invoiceNumber: invoice.invoice_number, qboInvoiceId: invoice.qbo_invoice_id, qboInvoiceLineId: line.id, qboLineId: line.qbo_line_id, sku: line.qbo_sku, quantity: line.ordered_qty }));
const duplicatePhysicalLines = physicalLines
  .filter(({ line }) => (erpLinesByQboLineId.get(line.id) ?? []).length > 1)
  .map(({ invoice, line }) => ({ invoiceNumber: invoice.invoice_number, qboInvoiceId: invoice.qbo_invoice_id, qboInvoiceLineId: line.id, erpLineIds: (erpLinesByQboLineId.get(line.id) ?? []).map((erpLine) => erpLine.id) }));
const printedNumberCollisions = candidateInvoices
  .filter((invoice) => (invoicesByPrintedNumber.get(normalized(invoice.invoice_number)) ?? []).length > 1)
  .map((invoice) => ({
    invoiceNumber: invoice.invoice_number,
    qboInvoiceId: invoice.qbo_invoice_id,
    samePrintedNumberQboInvoiceIds: (invoicesByPrintedNumber.get(normalized(invoice.invoice_number)) ?? []).map((candidate) => candidate.qbo_invoice_id),
    activeParentCount: (activeOrdersBySourceInvoice.get(invoice.id) ?? []).length,
    physicalLineRepresentations: (qboLinesByInvoice.get(invoice.id) ?? []).filter(isPhysicalLine).map((line) => ({ qboInvoiceLineId: line.id, qboLineId: line.qbo_line_id, sku: line.qbo_sku, quantity: line.ordered_qty, erpRepresentations: representationEvidence(line) })),
  }));
const missingParentRepresentations = candidateInvoices
  .filter((invoice) => (activeOrdersBySourceInvoice.get(invoice.id) ?? []).length === 0)
  .map((invoice) => ({
    invoiceNumber: invoice.invoice_number,
    qboInvoiceId: invoice.qbo_invoice_id,
    physicalLineRepresentations: (qboLinesByInvoice.get(invoice.id) ?? []).filter(isPhysicalLine).map((line) => ({ qboInvoiceLineId: line.id, qboLineId: line.qbo_line_id, sku: line.qbo_sku, quantity: line.ordered_qty, erpRepresentations: representationEvidence(line) })),
  }));

const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  scope: "Paid or Partially Paid cached QBO invoices dated on or after 2026-08-07. QBO first-payment eligibility is not verified by this database-only fallback.",
  summary: {
    candidateInvoices: candidateInvoices.length,
    physicalQboLines: physicalLines.length,
    representedInvoices: candidateInvoices.length - missingParents.length,
    missingParents: missingParents.length,
    duplicateActiveParentsSameQboIdentity: duplicateParents.length,
    missingPhysicalQboLineRepresentations: missingPhysicalLines.length,
    duplicatePhysicalQboLineRepresentations: duplicatePhysicalLines.length,
    printedNumberCollidingInvoiceInstances: printedNumberCollisions.length,
  },
  missingParents,
  missingParentRepresentations,
  duplicateParents,
  missingPhysicalLines,
  duplicatePhysicalLines,
  printedNumberCollisions,
};

fs.writeFileSync("tmp/import-reports/qbo-duplicate-identity-readonly-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));