#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  normalizeSku,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

const PAID_STATUSES = new Set(["Paid", "Partially Paid"]);
const SOURCE_TYPE = "QBO_INVOICE";

function parseArgs(argv) {
  const args = { apply: false, reportOut: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") args.apply = true;
    if (token === "--report-out") { args.reportOut = String(argv[i + 1] ?? "").trim(); i += 1; }
  }
  return args;
}

async function loadAll(supabase, table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) fail(`Could not read ${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function loadColumnSet(supabase, table, candidates) {
  const columns = new Set();
  for (const column of candidates) {
    const { error } = await supabase.from(table).select(column).limit(1);
    if (!error) columns.add(column);
  }
  return columns;
}

function filterPayload(payload, columns) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => columns.has(key)));
}

function buildProductMap(products, aliases) {
  const map = new Map();
  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (sku) map.set(sku, product.id);
  }
  for (const alias of aliases) {
    const sku = normalizeSku(alias.alias);
    if (sku) map.set(sku, alias.product_id);
  }
  return map;
}

function planOrders(invoices, invoiceLines, existingOrders, productMap) {
  const existingByInvoiceId = new Set(
    existingOrders
      .filter((row) => row.source_type === SOURCE_TYPE && row.source_invoice_id)
      .map((row) => row.source_invoice_id),
  );
  const linesByInvoice = new Map();
  for (const line of invoiceLines) {
    const rows = linesByInvoice.get(line.qbo_invoice_id) ?? [];
    rows.push(line);
    linesByInvoice.set(line.qbo_invoice_id, rows);
  }

  const eligible = invoices.filter((invoice) => PAID_STATUSES.has(invoice.payment_status));
  const plans = [];
  const exceptions = [];

  for (const invoice of eligible) {
    if (existingByInvoiceId.has(invoice.id)) continue;

    const lines = linesByInvoice.get(invoice.id) ?? [];
    const resolvedLines = lines.map((line) => ({
      ...line,
      product_id: line.product_id ?? productMap.get(normalizeSku(line.qbo_sku)) ?? null,
    }));
    const mappedLines = resolvedLines.filter((line) => line.product_id && Number(line.ordered_qty ?? 0) > 0);
    const unmappedLines = resolvedLines.filter((line) => !line.product_id && Number(line.ordered_qty ?? 0) > 0);

    if (lines.length === 0) {
      exceptions.push({ invoiceId: invoice.id, invoiceNumber: invoice.invoice_number, issue: "NO_INVOICE_LINES" });
      continue;
    }

    if (mappedLines.length === 0) {
      exceptions.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        issue: "NO_MAPPED_LINES",
        unmappedLineCount: unmappedLines.length,
      });
      continue;
    }

    plans.push({
      invoice,
      mappedLines,
      unmappedLines,
      sourceKey: `QBO_INVOICE:${invoice.qbo_invoice_id}`,
    });
  }

  return {
    eligible,
    plans,
    exceptions,
    summary: {
      qboInvoiceCount: invoices.length,
      paidOrPartiallyPaidCount: eligible.length,
      alreadyImportedCount: eligible.length - plans.length - exceptions.length,
      newOrderCount: plans.length,
      newMappedLineCount: plans.reduce((sum, plan) => sum + plan.mappedLines.length, 0),
      unmappedLineCount: plans.reduce((sum, plan) => sum + plan.unmappedLines.length, 0)
        + exceptions.reduce((sum, row) => sum + Number(row.unmappedLineCount ?? 0), 0),
      exceptionCount: exceptions.length,
    },
  };
}

async function applyPlans(supabase, plans, orderColumns, lineColumns) {
  let ordersInserted = 0;
  let linesInserted = 0;

  for (const plan of plans) {
    const invoice = plan.invoice;
    const orderPayload = filterPayload({
      customer_id: invoice.customer_id,
      source_invoice_id: invoice.id,
      order_number: invoice.invoice_number,
      source_type: SOURCE_TYPE,
      review_status: "PENDING_REVIEW",
      fulfillment_status: "PENDING",
      priority: "NORMAL",
      notes: "Imported from QuickBooks paid/partially paid invoice.",
    }, orderColumns);
    const { data: order, error: orderError } = await supabase
      .from("shipping_orders")
      .insert(orderPayload)
      .select("id")
      .single();

    if (orderError || !order?.id) {
      fail(`Could not create shipping order for invoice ${invoice.invoice_number}: ${orderError?.message ?? "unknown error"}`);
    }
    ordersInserted += 1;

    const lineRows = plan.mappedLines.map((line) => filterPayload({
      shipping_order_id: order.id,
      qbo_invoice_line_id: line.id,
      product_id: line.product_id,
      ordered_qty: line.ordered_qty,
      approved_qty: 0,
      fulfilled_qty: 0,
      cancelled_qty: 0,
      approval_status: "PENDING_REVIEW",
      warehouse_status: "PENDING_REVIEW",
      allocation_status: "UNALLOCATED",
      fulfillment_status: "PENDING",
      priority: "NORMAL",
      source_event_key: `QBO_INVOICE_LINE:${invoice.qbo_invoice_id}:${line.qbo_line_id}`,
    }, lineColumns));

    const { error: lineError } = await supabase.from("shipping_order_lines").insert(lineRows);
    if (lineError) fail(`Could not create shipping lines for invoice ${invoice.invoice_number}: ${lineError.message}`);
    linesInserted += lineRows.length;
  }

  return { ordersInserted, linesInserted };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabase = createSupabaseAdminClient();
  const [invoices, invoiceLines, existingOrders] = await Promise.all([
    loadAll(supabase, "qbo_invoices", "id, qbo_invoice_id, invoice_number, customer_id, payment_status, invoice_date, total_amount"),
    loadAll(supabase, "qbo_invoice_lines", "id, qbo_invoice_id, qbo_line_id, product_id, ordered_qty, qbo_sku, source_description"),
    loadAll(supabase, "shipping_orders", "id, source_invoice_id, source_type, order_number"),
  ]);

  const [products, aliases] = await Promise.all([
    loadAll(supabase, "products", "id, sku"),
    loadAll(supabase, "product_aliases", "product_id, alias"),
  ]);
  const plan = planOrders(invoices, invoiceLines, existingOrders, buildProductMap(products, aliases));
  const [orderColumns, lineColumns] = await Promise.all([
    loadColumnSet(supabase, "shipping_orders", ["customer_id", "source_invoice_id", "order_number", "source_type", "review_status", "fulfillment_status", "priority", "notes"]),
    loadColumnSet(supabase, "shipping_order_lines", ["shipping_order_id", "qbo_invoice_line_id", "product_id", "ordered_qty", "approved_qty", "fulfilled_qty", "cancelled_qty", "approval_status", "warehouse_status", "allocation_status", "fulfillment_status", "priority", "source_event_key"]),
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    paymentStatusesIncluded: Array.from(PAID_STATUSES),
    summary: plan.summary,
    exceptions: plan.exceptions.slice(0, 500),
    plannedOrders: plan.plans.map((item) => ({
      invoiceId: item.invoice.id,
      invoiceNumber: item.invoice.invoice_number,
      paymentStatus: item.invoice.payment_status,
      mappedLineCount: item.mappedLines.length,
      unmappedLineCount: item.unmappedLines.length,
    })),
    notes: [
      "Only Paid and Partially Paid QuickBooks invoices qualify.",
      "Existing QBO shipping orders are skipped by source_invoice_id.",
      "New order lines remain PENDING_REVIEW and do not allocate inventory.",
      "Invoices with no mapped product lines remain in exceptions for Shipping Review mapping.",
    ],
  };

  if (args.apply) report.applyResults = await applyPlans(supabase, plan.plans, orderColumns, lineColumns);

  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/paid-quickbooks-orders-${timestampSlug()}.json`);
  const resolved = writeJsonFile(reportPath, report);
  console.log("\n=== Paid QuickBooks Order Import ===\n");
  console.log(report.summary);
  if (report.applyResults) console.log("Apply results:", report.applyResults);
  console.log(`Report: ${resolved}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown QuickBooks order import failure"));
