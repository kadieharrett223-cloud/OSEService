#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const REPORT_DIR = "tmp/import-reports";
const REPORT_FILE = `${REPORT_DIR}/frozen-inventory-demand-reconciliation-preview.json`;
const MARKDOWN_FILE = `${REPORT_DIR}/frozen-inventory-demand-reconciliation-preview.md`;
const EXCLUDED_SKUS = new Set(["4PHDXL-12"]);

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase credentials. Run with node --env-file=.env.local.");
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const upper = (value) => String(value ?? "").trim().toUpperCase();
const quantity = (value) => Number(value ?? 0);
const openQty = (line) => Math.max(0, quantity(line.approved_qty) - quantity(line.fulfilled_qty));

async function loadAll(table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

function parseFrozenProof(fileName) {
  const document = fs.readFileSync(path.join(REPORT_DIR, fileName), "utf8");
  const sku = document.match(/^#\s+([^\s]+)\s+Invoice-by-Invoice Proof/m)?.[1] ?? null;
  if (!sku || EXCLUDED_SKUS.has(upper(sku)) || !/Status:\s+FROZEN locally as RECONCILED/i.test(document)) return null;

  const lines = document.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes("Expected SOLD") && line.includes("ERP SOLD"));
  if (headerIndex < 0 || !lines[headerIndex + 2]) return { sku, fileName, parseError: "Expected/ERP comparison table is missing." };
  const headers = lines[headerIndex].split("|").map((value) => value.trim()).filter(Boolean);
  const values = lines[headerIndex + 2].split("|").map((value) => value.trim()).filter(Boolean);
  const table = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? null]));
  const closedInvoices = lines.flatMap((line) => {
    const match = line.match(/^\|[^|]*\|\s*`([^`]+)`\s*\|[^|]*\|.*\|\s*0\s*\|\s*$/);
    return match ? [match[1]] : [];
  });

  return {
    sku,
    fileName,
    expectedSold: quantity(table["Expected SOLD"]),
    expectedAvailable: quantity(table["Available Now"]),
    erpSold: quantity(table["ERP SOLD"]),
    erpAvailable: quantity(table["ERP Available"]),
    closedInvoices: [...new Set(closedInvoices)],
  };
}

const proofFiles = fs.readdirSync(REPORT_DIR).filter((file) => file.endsWith("-invoice-proof.md"));
const proofs = proofFiles.map(parseFrozenProof).filter((proof) => proof && !proof.parseError);
const excludedProofs = proofFiles.filter((file) => file.startsWith("4phdxl-12-"));
const [products, aliases, orders, lines] = await Promise.all([
  loadAll("products", "id,sku"),
  loadAll("product_aliases", "product_id,alias"),
  loadAll("shipping_orders", "id,source_invoice_id,order_number,source_type,duplicate_of_order_id,review_status,cancellation_status,legacy_customer_name,qbo_invoices(invoice_number,customers(company_name,full_name))"),
  loadAll("shipping_order_lines", "id,shipping_order_id,product_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,qbo_invoice_line_id,source_record_id"),
]);

const ordersById = new Map(orders.map((order) => [order.id, order]));
const productIdsBySku = new Map();
for (const product of products) productIdsBySku.set(upper(product.sku), new Set([product.id]));
for (const alias of aliases) {
  const ids = productIdsBySku.get(upper(alias.alias)) ?? new Set();
  ids.add(alias.product_id);
  productIdsBySku.set(upper(alias.alias), ids);
}

const candidates = [];
const summaries = [];
for (const proof of proofs) {
  const productIds = productIdsBySku.get(upper(proof.sku)) ?? new Set();
  const closedInvoices = new Set(proof.closedInvoices.map(String));
  const scopedLines = lines.filter((line) => productIds.has(line.product_id));
  const closedLines = scopedLines.filter((line) => {
    const parent = ordersById.get(line.shipping_order_id);
    const invoice = String(parent?.qbo_invoices?.invoice_number ?? parent?.order_number ?? "");
    return closedInvoices.has(invoice) && openQty(line) > 0;
  });

  const candidateRows = closedLines.map((line) => {
    const parent = ordersById.get(line.shipping_order_id);
    const invoice = String(parent?.qbo_invoices?.invoice_number ?? parent?.order_number ?? "—");
    const customer = parent?.qbo_invoices?.customers?.company_name ?? parent?.qbo_invoices?.customers?.full_name ?? parent?.legacy_customer_name ?? "Customer pending";
    const parentStatus = parent?.duplicate_of_order_id ? "DUPLICATE" : parent?.cancellation_status ?? parent?.review_status ?? "OPEN";
    const lineStatus = `${line.approval_status ?? "PENDING"}/${line.fulfillment_status ?? "PENDING"}`;
    return {
      sku: proof.sku,
      invoice,
      customer,
      lineId: line.id,
      orderId: parent?.id ?? null,
      currentParentStatus: parentStatus,
      currentLineStatus: lineStatus,
      proposedParentStatus: "NO_WRITE",
      proposedLineStatus: "NO_WRITE",
      duplicateRelationship: parent?.duplicate_of_order_id ?? null,
      quantityImpactOnSold: -openQty(line),
      quantityImpactOnAvailable: openQty(line),
      reason: `Frozen ${proof.fileName} marks invoice ${invoice} as closed with zero Expected SOLD effect. The shared projection excludes it without rewriting historical lifecycle data.`,
      evidence: proof.fileName,
      disposition: "PROJECTION_ONLY",
    };
  });
  candidates.push(...candidateRows);
  summaries.push({
    sku: proof.sku,
    evidence: proof.fileName,
    before: { sold: proof.erpSold, available: proof.erpAvailable },
    expectedAfter: { sold: proof.expectedSold, available: proof.expectedAvailable },
    liveStaleLineCount: candidateRows.length,
    proposedWriteCount: 0,
    unresolved: false,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  applyExecuted: false,
  excludedSkus: [...EXCLUDED_SKUS],
  excludedProofs,
  scope: "Frozen fully reconciled invoice-proof artifacts only.",
  summaries,
  proposedChanges: candidates,
  ambiguousRecords: [],
  safeguards: [
    "No inventory_transactions are read as correction targets or written.",
    "No physical ON_FLOOR quantities, shipment events, receipt events, or container history are changed.",
    "4PHDXL-12 is excluded because its physical baseline is unresolved.",
    "This preview contains no executable data writes; each candidate requires an explicit lifecycle-specific plan before apply.",
  ],
};

fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
const markdown = [
  "# Frozen Inventory Demand Reconciliation Preview",
  "",
  "Read-only. No production writes were executed.",
  "",
  "## SKU Totals",
  "",
  "| SKU | Before Sold | After Sold | Before Available | After Available | Candidate stale lines | Proposed writes |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...summaries.map((row) => `| ${row.sku} | ${row.before.sold} | ${row.expectedAfter.sold} | ${row.before.available} | ${row.expectedAfter.available} | ${row.liveStaleLineCount} | ${row.proposedWriteCount} |`),
  "",
  "## Candidate Records",
  "",
  "| SKU | Invoice | Customer | Current parent | Current line | Proposed parent | Proposed line | Duplicate relationship | Sold impact | Available impact | Evidence |",
  "|---|---|---|---|---|---|---|---|---:|---:|---|",
  ...candidates.map((row) => `| ${row.sku} | ${row.invoice} | ${row.customer} | ${row.currentParentStatus} | ${row.currentLineStatus} | ${row.proposedParentStatus} | ${row.proposedLineStatus} | ${row.duplicateRelationship ?? "—"} | ${row.quantityImpactOnSold} | ${row.quantityImpactOnAvailable} | ${row.evidence} |`),
  "",
  "## Exclusions",
  "",
  "- `4PHDXL-12` remains excluded from every physical and availability correction.",
  "- No candidate is automatically applied by this preview.",
  "",
];
fs.writeFileSync(MARKDOWN_FILE, markdown.join("\n"));
console.log(JSON.stringify({ report: REPORT_FILE, markdown: MARKDOWN_FILE, skuCount: summaries.length, candidateCount: candidates.length, proposedWriteCount: 0, excludedSkus: [...EXCLUDED_SKUS] }, null, 2));