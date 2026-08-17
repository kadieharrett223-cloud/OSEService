#!/usr/bin/env node

import fs from "node:fs";

const preview = JSON.parse(fs.readFileSync("tmp/import-reports/final-order-state-preview.json", "utf8"));
const rootCauses = JSON.parse(fs.readFileSync("tmp/import-reports/queue-failure-root-cause-simulation.json", "utf8"));
const heldSkus = new Set(["HLCJ-6", "JVCJ-6", "000185", "10000006", "HPU1103", "2PCFHD-12"]);
const heldInvoices = new Set(["126037"]);
const staleSkus = new Set(rootCauses.failures.filter(row => row.rootCause === "STALE_OLD_ERP_ORDER").map(row => row.sku));
const manifest = [];
const seen = new Set();

for (const row of preview.preview) {
  if (heldSkus.has(String(row.sku ?? "").toUpperCase()) || heldInvoices.has(String(row.invoice ?? "").toUpperCase())) continue;
  if (row.action === "REVIEW_CONFLICT") continue;
  const action = staleSkus.has(String(row.sku ?? "").toUpperCase())
    ? "REMOVE_STALE_OLD_ERP_LINE"
    : row.action === "REMOVE_DUPLICATE_OLD_ERP_ORDER"
      ? "REMOVE_DUPLICATE_OLD_ERP_ORDER"
      : row.action;
  if (!["KEEP", "ADD_MISSING_LINE", "CORRECT_LINE", "REMOVE_DUPLICATE_OLD_ERP_ORDER", "REMOVE_STALE_OLD_ERP_LINE"].includes(action)) continue;
  const key = `${row.invoice}|${row.sku}|${action}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const summary = preview.invoiceSummaries.find(item => item.invoice === row.invoice);
  manifest.push({ invoice: row.invoice, orderId: summary?.qboOrderIds?.[0] ?? summary?.oldErpOrderIds?.[0] ?? null, survivingSource: summary?.qboOrderIds?.length ? "QBO_INVOICE" : "OLD_ERP", sku: row.sku, qty: row.proposedFinalRemainingQty, action });
}

const result = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  applyExecuted: false,
  heldSkus: [...heldSkus],
  heldInvoices: [...heldInvoices],
  readyRows: manifest,
  summary: {
    readyRows: manifest.length,
    heldManualMappingRows: rootCauses.failures.filter(row => row.rootCause === "WRONG_PRODUCT_ALIAS" || row.sku === "HLCJ-6").length,
    heldManualReviewInvoices: 1,
    duplicateOrdersReadyToRetire: manifest.filter(row => row.action === "REMOVE_DUPLICATE_OLD_ERP_ORDER").length,
    staleLinesReadyToRemove: manifest.filter(row => row.action === "REMOVE_STALE_OLD_ERP_LINE").length,
  },
};
fs.writeFileSync("tmp/import-reports/ready-to-apply-manifest.json", JSON.stringify(result, null, 2));
const lines = ["# Ready-to-Apply Manifest (Read-Only)", "", "No rows have been applied. This manifest excludes held product mappings and invoice 126037.", "", "| Invoice | Order ID | Surviving Source | SKU | Qty | Action |", "|---|---|---|---|---:|---|"];
for (const row of manifest) lines.push(`| ${row.invoice ?? "—"} | ${row.orderId ?? "—"} | ${row.survivingSource} | ${row.sku ?? "—"} | ${row.qty ?? 0} | ${row.action} |`);
lines.push("", "## Final Split", "", `- Ready rows: ${result.summary.readyRows}`, `- Held manual-mapping rows: ${result.summary.heldManualMappingRows}`, `- Held manual-review invoices: ${result.summary.heldManualReviewInvoices}`, `- Duplicate OLD_ERP orders ready to retire: ${result.summary.duplicateOrdersReadyToRetire}`, `- Stale OLD_ERP lines ready to remove: ${result.summary.staleLinesReadyToRemove}`, "", "Apply is intentionally not executed.");
fs.writeFileSync("tmp/import-reports/ready-to-apply-manifest.md", `${lines.join("\n")}\n`);
console.log(JSON.stringify({ json: "tmp/import-reports/ready-to-apply-manifest.json", markdown: "tmp/import-reports/ready-to-apply-manifest.md", summary: result.summary }, null, 2));
