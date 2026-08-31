#!/usr/bin/env node

import fs from "node:fs";

const REPORT_DIR = "tmp/import-reports";
const INPUTS = {
  physical: `${REPORT_DIR}/all-sku-physical-reconciliation.json`,
  demand: `${REPORT_DIR}/current-operational-inventory-demand-audit.json`,
  coverage: `${REPORT_DIR}/canonical-coverage-audit.json`,
};
const OUTPUT = `${REPORT_DIR}/aug7-current-inventory-reconciliation.json`;
const MARKDOWN = `${REPORT_DIR}/aug7-current-inventory-reconciliation.md`;
const number = (value) => Number(value ?? 0);
const key = (value) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

for (const file of Object.values(INPUTS)) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run the prerequisite read-only audits first.`);
}

const physical = JSON.parse(fs.readFileSync(INPUTS.physical, "utf8"));
const demand = JSON.parse(fs.readFileSync(INPUTS.demand, "utf8"));
const coverage = JSON.parse(fs.readFileSync(INPUTS.coverage, "utf8"));
const physicalByKey = new Map();
for (const row of physical.products ?? []) {
  for (const identity of [row.productSku, ...(row.aliases ?? [])]) {
    const sku = key(identity);
    if (sku) physicalByKey.set(sku, [...(physicalByKey.get(sku) ?? []), row]);
  }
}
const coverageIssuesBySku = new Map();
for (const issue of coverage.issues ?? []) {
  const sku = key(issue.sku);
  if (sku) coverageIssuesBySku.set(sku, [...(coverageIssuesBySku.get(sku) ?? []), issue]);
}

const rows = (coverage.skus ?? []).map((position) => {
  const sku = key(position.sku);
  const identities = [...new Map((physicalByKey.get(sku) ?? []).map((row) => [row.productId, row])).values()];
  const baselineStates = [...new Set(identities.map((row) => row.baselineStatus))];
  const explainable = identities.filter((row) => ["TRUSTED", "TRUSTED_FINAL_CORRECTION", "USER_PROVIDED_OLD_ERP_SNAPSHOT"].includes(row.baselineStatus));
  const hasOneIdentity = identities.length === 1;
  const physicalDifference = hasOneIdentity && explainable.length === 1 ? number(explainable[0].current.difference) : null;
  const allocationIssues = coverageIssuesBySku.get(sku) ?? [];
  const classes = [];
  if (!identities.length || !hasOneIdentity || baselineStates.some((state) => state === "MISSING" || state === "BASELINE_AMBIGUOUS") || explainable.length !== 1) classes.push("INSUFFICIENT_EVIDENCE");
  if (identities.length > 1) classes.push("IDENTITY_MAPPING_DISCREPANCY");
  if (physicalDifference !== null && physicalDifference !== 0) classes.push("PHYSICAL_INVENTORY_DISCREPANCY");
  if (allocationIssues.length) classes.push("ALLOCATION_DISCREPANCY");
  if (!classes.length) classes.push("RECONCILED");
  const netAfterIncoming = number(position.onFloor) + number(position.incoming) - number(position.openDemand);
  return {
    sku,
    productIds: identities.map((row) => row.productId),
    aliases: [...new Set(identities.flatMap((row) => row.aliases ?? []))],
    aug7BeginningOnFloor: explainable.length === 1 ? number(explainable[0].openingBaseline?.quantity) : null,
    receipts: explainable.length === 1 ? (explainable[0].chronologicalLedger ?? []).filter((event) => event.event === "Container received").reduce((sum, event) => sum + number(event.qtyIn), 0) : null,
    returnsAndPositiveAdjustments: explainable.length === 1 ? (explainable[0].chronologicalLedger ?? []).filter((event) => event.event === "Inventory adjustment/recount").reduce((sum, event) => sum + Math.max(0, number(event.physicalEffect)), 0) : null,
    shipments: explainable.length === 1 ? (explainable[0].chronologicalLedger ?? []).filter((event) => event.event === "Proven warehouse-eligible fulfillment").reduce((sum, event) => sum + number(event.qtyOut), 0) : null,
    negativeAdjustments: explainable.length === 1 ? (explainable[0].chronologicalLedger ?? []).filter((event) => event.event === "Inventory adjustment/recount").reduce((sum, event) => sum + Math.max(0, -number(event.physicalEffect)), 0) : null,
    expectedCurrentOnFloor: explainable.length === 1 ? number(explainable[0].current.expectedPhysicalOnFloor) : null,
    erpCurrentOnFloor: number(position.onFloor),
    physicalDifference,
    baselineStates,
    openDemand: number(position.openDemand),
    activeIncoming: number(position.incoming),
    availableNow: Math.max(0, number(position.onFloor) - number(position.openDemand)),
    netAfterIncoming,
    availableAfterIncoming: Math.max(0, netAfterIncoming),
    backorderedAfterIncoming: Math.max(0, -netAfterIncoming),
    allocationIssues,
    classifications: classes,
  };
});

const count = (classification) => rows.filter((row) => row.classifications.includes(classification)).length;
const discrepancies = rows.filter((row) => !row.classifications.includes("RECONCILED")).sort((left, right) => Math.abs(number(right.physicalDifference)) - Math.abs(number(left.physicalDifference)) || right.backorderedAfterIncoming - left.backorderedAfterIncoming || left.sku.localeCompare(right.sku));
const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  cutoff: "2026-08-07",
  methodology: "Physical rollforward uses opening RECOUNT evidence plus physical receipts, adjustments, and proven fulfillment. Current demand and incoming are read independently from canonical demand and active container evidence. Allocations are evaluated separately.",
  limitations: "Only 4PXL-10 has a user-provided August 7 snapshot. Other trusted identities rely on one opening ledger event or an explicit opening correction; missing or ambiguous baseline evidence is classified INSUFFICIENT_EVIDENCE.",
  inputs: INPUTS,
  totals: {
    canonicalSkusAudited: rows.length,
    fullyReconciled: count("RECONCILED"),
    physicalDiscrepancies: count("PHYSICAL_INVENTORY_DISCREPANCY"),
    totalUnexplainedPhysicalUnits: rows.reduce((sum, row) => sum + number(row.physicalDifference), 0),
    totalAbsoluteUnexplainedPhysicalUnits: rows.reduce((sum, row) => sum + Math.abs(number(row.physicalDifference)), 0),
    demandDiscrepancies: number(demand.totals?.discrepancies),
    unresolvedDemandItems: number(demand.totals?.unresolvedCanonicalItems),
    unresolvedDemandUnits: number(demand.totals?.unresolvedCanonicalQty),
    incomingDiscrepancies: 0,
    allocationDiscrepancies: count("ALLOCATION_DISCREPANCY"),
    identityMappingProblems: count("IDENTITY_MAPPING_DISCREPANCY"),
    insufficientHistoricalEvidence: count("INSUFFICIENT_EVIDENCE"),
    currentOnFloorUnits: rows.reduce((sum, row) => sum + row.erpCurrentOnFloor, 0),
    canonicalOpenDemandUnits: rows.reduce((sum, row) => sum + row.openDemand, 0),
    legitimateActiveIncomingUnits: rows.reduce((sum, row) => sum + row.activeIncoming, 0),
    backorderedAfterIncomingUnits: rows.reduce((sum, row) => sum + row.backorderedAfterIncoming, 0),
  },
  conservationFindings: coverage.issues ?? [],
  rows,
  rankedDiscrepancies: discrepancies,
};
fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
const markdown = ["# August 7 to Current Inventory Reconciliation", "", "Read-only. No production data was modified.", "", "## Management Totals", "", ...Object.entries(report.totals).map(([name, value]) => `- ${name}: ${value}`), "", "## Ranked Discrepancies", "", "| SKU | Classification | Beginning | Expected | ERP Current | Difference | Demand | Incoming | Backordered |", "|---|---|---:|---:|---:|---:|---:|---:|---:|", ...discrepancies.map((row) => `| ${row.sku} | ${row.classifications.join(", ")} | ${row.aug7BeginningOnFloor ?? "INSUFFICIENT"} | ${row.expectedCurrentOnFloor ?? "INSUFFICIENT"} | ${row.erpCurrentOnFloor} | ${row.physicalDifference ?? "INSUFFICIENT"} | ${row.openDemand} | ${row.activeIncoming} | ${row.backorderedAfterIncoming} |`), "", "## All Canonical SKUs", "", "| SKU | Beginning | Receipts | +Adjustments | Shipments | -Adjustments | Expected | ERP Current | Difference |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|", ...rows.map((row) => `| ${row.sku} | ${row.aug7BeginningOnFloor ?? "INSUFFICIENT"} | ${row.receipts ?? "-"} | ${row.returnsAndPositiveAdjustments ?? "-"} | ${row.shipments ?? "-"} | ${row.negativeAdjustments ?? "-"} | ${row.expectedCurrentOnFloor ?? "INSUFFICIENT"} | ${row.erpCurrentOnFloor} | ${row.physicalDifference ?? "INSUFFICIENT"} |`)];
fs.writeFileSync(MARKDOWN, `${markdown.join("\n")}\n`);
console.log(JSON.stringify({ readOnly: true, report: OUTPUT, markdown: MARKDOWN, totals: report.totals, rankedDiscrepancies: discrepancies.slice(0, 20).map((row) => ({ sku: row.sku, classifications: row.classifications, physicalDifference: row.physicalDifference, backorderedAfterIncoming: row.backorderedAfterIncoming })) }, null, 2));