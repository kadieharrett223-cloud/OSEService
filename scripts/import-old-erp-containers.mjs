#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_ACTIVE_CONTAINER_UNITS = {
  "230": 24,
  "232": 32,
  "234": 28,
  "235": 52,
  "236": 18,
  "238": 28,
  "239": 5,
  "240": 48,
  "241": 11,
  "244": 24,
  "245": 55,
  "246": 15,
  "247": 31,
  "249": 29,
  "250": 33,
  "251": 22,
  "252": 23,
  "253": 50,
};

const EXPECTED_ACTIVE_CONTAINER_IDS = [
  "230",
  "232",
  "234",
  "235",
  "236",
  "238",
  "239",
  "240",
  "241",
  "244",
  "245",
  "246",
  "247",
  "249",
  "250",
  "251",
  "252",
  "253",
];

const EXPECTED_ACTIVE_CONTAINER_COUNT = 18;
const EXPECTED_ACTIVE_TOTAL_UNITS = 714;

function parseArgs(argv) {
  const args = {
    input: "",
    apply: false,
    reportOut: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") {
      args.input = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--report-out") {
      args.reportOut = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
  }

  return args;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function readJsonFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    fail(`Input file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.records)) return parsed.records;
    if (Array.isArray(parsed?.items)) return parsed.items;
    fail("Input JSON must be an array or include a records/items array.");
  } catch (error) {
    fail(`Could not parse JSON input: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return [];
}

function pickFirst(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y";
}

function toNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function toDateString(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeSku(value) {
  const sku = String(value ?? "").trim().toUpperCase();
  return sku.length > 0 ? sku : null;
}

function normalizeContainerNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  return digits || raw.toUpperCase();
}

function parseLineItems(record) {
  const candidate = pickFirst(record, [
    "lineItems",
    "items",
    "containerLines",
    "contents",
    "products",
    "productLines",
  ]);

  if (!Array.isArray(candidate)) return [];

  return candidate
    .map((line) => {
      const sku = normalizeSku(pickFirst(line, ["sku", "partNumber", "part_number", "itemSku", "itemCode", "productCode"]));
      const qty = toNumber(pickFirst(line, ["orderedQty", "ordered_qty", "qty", "quantity", "onOrderQty"]));
      const receivedQty = toNumber(pickFirst(line, ["receivedQty", "received_qty", "qtyReceived", "received"]));
      const sourceLineRef = normalizeText(pickFirst(line, ["id", "lineId", "sourceLineId", "reference"]));

      if (!sku || !qty || qty <= 0) {
        return null;
      }

      return {
        sku,
        orderedQty: qty,
        receivedQty: receivedQty && receivedQty > 0 ? receivedQty : 0,
        sourceLineRef,
      };
    })
    .filter((line) => Boolean(line));
}

function deriveLifecycle(record, inventoryState) {
  if (inventoryState !== "ON_ORDER") {
    return { lifecycleStatus: "ORDERED", needsReview: true, reason: "Inventory state is not ON_ORDER" };
  }

  const finalPaymentDate = toDateString(pickFirst(record, ["finalPaymentDate", "final_payment_date"]));
  const finalPaymentAmount = toNumber(pickFirst(record, ["finalPaymentAmount", "final_payment_amount"]));
  const finalPaymentStatus = String(pickFirst(record, ["finalPaymentStatus", "final_payment_status", "paymentStatusFinal"]) ?? "").toLowerCase();

  const hasFinalPaymentSignal = Boolean(
    finalPaymentDate
      || (finalPaymentAmount && finalPaymentAmount > 0)
      || finalPaymentStatus.includes("paid")
      || finalPaymentStatus.includes("complete"),
  );

  const hasExplicitNotPaidSignal = finalPaymentStatus.includes("unpaid")
    || finalPaymentStatus.includes("pending")
    || finalPaymentStatus.includes("not paid");

  if (hasFinalPaymentSignal) {
    return { lifecycleStatus: "INBOUND", needsReview: false, reason: null };
  }

  if (hasExplicitNotPaidSignal || finalPaymentAmount === 0 || finalPaymentAmount === null) {
    return { lifecycleStatus: "PRODUCTION", needsReview: false, reason: null };
  }

  return {
    lifecycleStatus: "ORDERED",
    needsReview: true,
    reason: "Not enough final payment information to safely classify as PRODUCTION or INBOUND",
  };
}

function normalizePaymentStatus(record) {
  const raw = String(pickFirst(record, ["paymentStatus", "payment_status", "payment_state"]) ?? "").trim();
  if (!raw) return "Pending";
  const normalized = raw.toLowerCase();

  if (normalized.includes("partial")) return "Partially Paid";
  if (normalized.includes("paid") || normalized.includes("complete")) return "Paid";
  if (normalized.includes("cancel")) return "Cancelled";
  return "Pending";
}

function collectCandidates(rawRecords) {
  const candidates = [];
  const exclusionStats = {
    missingSourceRecordId: 0,
    removedTrue: 0,
    receivedState: 0,
    nonOnOrderState: 0,
    emptyOrInvalidContents: 0,
  };

  let detectedWithSourceId = 0;

  for (const record of rawRecords) {
    const sourceRecordId = normalizeText(pickFirst(record, ["id", "_id", "containerDraftId", "draftId", "recordId"]));
    if (!sourceRecordId) {
      exclusionStats.missingSourceRecordId += 1;
      continue;
    }

    detectedWithSourceId += 1;

    const sourceKey = `OLD_ERP_CONTAINER:${sourceRecordId}`;
    const removed = toBool(pickFirst(record, ["removed", "isRemoved", "deleted"]));
    if (removed) {
      exclusionStats.removedTrue += 1;
      continue;
    }

    const inventoryState = String(pickFirst(record, ["inventoryState", "inventory_state", "inventoryStatus", "status"]) ?? "").trim().toUpperCase();
    if (inventoryState === "RECEIVED") {
      exclusionStats.receivedState += 1;
      continue;
    }
    if (inventoryState !== "ON_ORDER") {
      exclusionStats.nonOnOrderState += 1;
      continue;
    }

    const lines = parseLineItems(record);
    if (lines.length === 0) {
      exclusionStats.emptyOrInvalidContents += 1;
      continue;
    }

    const lifecycle = deriveLifecycle(record, inventoryState);

    const containerNumber = normalizeText(pickFirst(record, ["containerNumber", "container_number", "number", "containerNo"]));
    const supplier = normalizeText(pickFirst(record, ["supplier", "vendor", "supplierName", "vendorName"]));
    const orderDate = toDateString(pickFirst(record, ["orderDate", "purchaseDate", "purchase_order_date", "order_date"]));
    const enteredDate = toDateString(pickFirst(record, ["enteredDate", "createdAt", "created_at", "dateEntered", "draftCreatedAt"]));
    const trackingNumber = normalizeText(pickFirst(record, ["trackingNumber", "tracking_number"]));
    const portDate = toDateString(pickFirst(record, ["portDate", "port_date", "etaPortDate", "eta_port_date", "eta", "etaDate"]));
    const paymentStatus = normalizePaymentStatus(record);

    const depositAmount = toNumber(pickFirst(record, ["depositAmount", "deposit_amount"]));
    const depositDate = toDateString(pickFirst(record, ["depositDate", "deposit_date"]));
    const finalPaymentAmount = toNumber(pickFirst(record, ["finalPaymentAmount", "final_payment_amount"]));
    const finalPaymentDate = toDateString(pickFirst(record, ["finalPaymentDate", "final_payment_date"]));
    const remainingBalance = toNumber(pickFirst(record, ["remainingBalance", "remaining_balance", "balanceRemaining"]));
    const notes = normalizeText(pickFirst(record, ["notes", "internalNotes", "memo"]));

    candidates.push({
      sourceKey,
      sourceRecordId,
      sourceSystem: "OLD_ERP",
      containerNumber: containerNumber ?? sourceRecordId,
      normalizedContainerNumber: normalizeContainerNumber(containerNumber ?? sourceRecordId),
      supplier,
      orderDate,
      enteredDate,
      trackingNumber,
      portDate,
      paymentStatus,
      depositAmount,
      depositDate,
      finalPaymentAmount,
      finalPaymentDate,
      remainingBalance,
      lifecycleStatus: lifecycle.lifecycleStatus,
      needsLifecycleReview: lifecycle.needsReview,
      lifecycleReviewReason: lifecycle.reason,
      notes,
      inventoryState,
      lines,
    });
  }

  return {
    sourceRecordCount: rawRecords.length,
    detectedWithSourceId,
    candidates,
    exclusionStats,
  };
}

async function loadProductMap(supabase) {
  const { data, error } = await supabase.from("products").select("id, sku");
  if (error) {
    fail(`Could not read products: ${error.message}`);
  }

  const map = new Map();
  for (const row of data ?? []) {
    const sku = normalizeSku(row.sku);
    if (sku) {
      map.set(sku, row.id);
    }
  }
  return map;
}

function createPreview(candidates, productMap) {
  const previewRows = [];
  const mappingIssues = [];
  let totalLines = 0;
  let totalUnits = 0;
  const uniqueUnmappedSkus = new Set();
  const importUnitsByContainer = new Map();

  for (const candidate of candidates) {
    const unresolvedSkus = new Set();
    let units = 0;

    for (const line of candidate.lines) {
      totalLines += 1;
      units += line.orderedQty;
      totalUnits += line.orderedQty;
      importUnitsByContainer.set(
        candidate.normalizedContainerNumber ?? candidate.containerNumber,
        (importUnitsByContainer.get(candidate.normalizedContainerNumber ?? candidate.containerNumber) ?? 0) + line.orderedQty,
      );
      if (!productMap.has(line.sku)) {
        unresolvedSkus.add(line.sku);
        uniqueUnmappedSkus.add(line.sku);
      }
    }

    const issueMessages = [];
    if (unresolvedSkus.size > 0) {
      issueMessages.push(`${unresolvedSkus.size} SKU(s) unmapped`);
      mappingIssues.push({
        sourceKey: candidate.sourceKey,
        containerNumber: candidate.containerNumber,
        skus: Array.from(unresolvedSkus),
      });
    }
    if (candidate.needsLifecycleReview) {
      issueMessages.push("Lifecycle review required");
    }

    previewRows.push({
      "Container #": candidate.containerNumber,
      Supplier: candidate.supplier ?? "—",
      Status: candidate.lifecycleStatus,
      "ETA/Port Date": candidate.portDate ?? "—",
      "Payment Status": candidate.paymentStatus,
      "# SKUs": candidate.lines.length,
      "Total Units": units,
      "Mapping Issues": issueMessages.length > 0 ? issueMessages.join("; ") : "None",
    });
  }

  return {
    previewRows,
    mappingIssues,
    importUnitsByContainer,
    totals: {
      containerCount: candidates.length,
      lineCount: totalLines,
      unitCount: totalUnits,
      containersWithMappingIssues: new Set(mappingIssues.map((entry) => entry.sourceKey)).size,
      totalUnmappedSkuLines: mappingIssues.reduce((sum, entry) => sum + entry.skus.length, 0),
      totalUnmappedSkusUnique: uniqueUnmappedSkus.size,
    },
  };
}

function createExpectedComparison(importUnitsByContainer, mappingIssues) {
  const mappingIssueSet = new Set(mappingIssues.map((entry) => normalizeContainerNumber(entry.containerNumber) ?? entry.containerNumber));
  const rows = [];

  for (const container of EXPECTED_ACTIVE_CONTAINER_IDS) {
    const expectedQty = Number(EXPECTED_ACTIVE_CONTAINER_UNITS[container] ?? 0);
    const importQty = Number(importUnitsByContainer.get(container) ?? 0);
    rows.push({
      Container: container,
      "Expected Qty": expectedQty,
      "Import Qty": importQty,
      Difference: importQty - expectedQty,
      "Mapping Issues": mappingIssueSet.has(container) ? "Yes" : "No",
    });
  }

  for (const [container, importQty] of importUnitsByContainer.entries()) {
    if (Object.prototype.hasOwnProperty.call(EXPECTED_ACTIVE_CONTAINER_UNITS, container)) continue;
    rows.push({
      Container: container,
      "Expected Qty": 0,
      "Import Qty": importQty,
      Difference: importQty,
      "Mapping Issues": mappingIssueSet.has(container) ? "Yes" : "No",
    });
  }

  rows.sort((a, b) => String(a.Container).localeCompare(String(b.Container), undefined, { numeric: true }));

  const expectedContainerCount = EXPECTED_ACTIVE_CONTAINER_IDS.length;
  const configuredExpectedUnits = EXPECTED_ACTIVE_CONTAINER_IDS.reduce(
    (sum, container) => sum + Number(EXPECTED_ACTIVE_CONTAINER_UNITS[container] ?? 0),
    0,
  );
  const expectedTotalUnits = EXPECTED_ACTIVE_TOTAL_UNITS;
  const importedExpectedContainers = rows.filter((row) => row["Expected Qty"] > 0 && row["Import Qty"] > 0).length;
  const nonZeroDifferences = rows.filter((row) => row.Difference !== 0).length;

  return {
    rows,
    checksum: {
      expectedContainerCount,
      expectedTargetCount: EXPECTED_ACTIVE_CONTAINER_COUNT,
      expectedTotalUnits,
      expectedTargetUnits: EXPECTED_ACTIVE_TOTAL_UNITS,
      configuredExpectedUnits,
      importedExpectedContainers,
      importedTotalUnits: Array.from(importUnitsByContainer.values()).reduce((sum, qty) => sum + Number(qty), 0),
      nonZeroDifferences,
    },
  };
}

async function getSourceKeyConflicts(supabase, sourceKeys) {
  if (sourceKeys.length === 0) return [];

  const { data, error } = await supabase
    .from("containers")
    .select("id, container_number, source_key")
    .in("source_key", sourceKeys);

  if (error) {
    fail(`Could not check source-key conflicts: ${error.message}`);
  }

  return data ?? [];
}

async function applyImport(supabase, candidates, productMap) {
  const results = {
    containersUpserted: 0,
    linesUpserted: 0,
    linesSkippedUnmapped: 0,
    containersWithIssues: 0,
    issueDetails: [],
  };

  for (const candidate of candidates) {
    const baseNotes = candidate.notes ? [candidate.notes] : [];
    if (candidate.needsLifecycleReview) {
      baseNotes.push(`IMPORT REVIEW: ${candidate.lifecycleReviewReason}`);
    }

    const payload = {
      container_number: candidate.containerNumber,
      supplier: candidate.supplier,
      order_date: candidate.orderDate,
      entered_date: candidate.enteredDate,
      tracking_number: candidate.trackingNumber,
      port_date: candidate.portDate,
      eta_confirmed_date: candidate.portDate,
      payment_status: candidate.paymentStatus,
      deposit_date: candidate.depositDate,
      deposit_amount: candidate.depositAmount,
      final_payment_date: candidate.finalPaymentDate,
      final_payment_amount: candidate.finalPaymentAmount,
      remaining_balance: candidate.remainingBalance,
      lifecycle_status: candidate.lifecycleStatus,
      notes: baseNotes.length > 0 ? baseNotes.join("\n\n") : null,
      source_system: candidate.sourceSystem,
      source_record_id: candidate.sourceRecordId,
      source_key: candidate.sourceKey,
    };

    const { data: upsertedContainer, error: upsertContainerError } = await supabase
      .from("containers")
      .upsert(payload, { onConflict: "source_key" })
      .select("id")
      .single();

    if (upsertContainerError || !upsertedContainer?.id) {
      fail(`Container upsert failed for ${candidate.sourceKey}: ${upsertContainerError?.message ?? "unknown error"}`);
    }

    results.containersUpserted += 1;

    let hasIssue = false;
    for (const line of candidate.lines) {
      const productId = productMap.get(line.sku);
      if (!productId) {
        hasIssue = true;
        results.linesSkippedUnmapped += 1;
        results.issueDetails.push({
          sourceKey: candidate.sourceKey,
          containerNumber: candidate.containerNumber,
          issue: "UNMAPPED_SKU",
          sku: line.sku,
        });
        continue;
      }

      const linePayload = {
        container_id: upsertedContainer.id,
        product_id: productId,
        ordered_qty: line.orderedQty,
        on_order_qty: line.orderedQty,
        received_qty: line.receivedQty > 0 ? line.receivedQty : 0,
        product_mapping_status: "MAPPED",
        source_line_ref: line.sourceLineRef,
      };

      const { error: lineError } = await supabase
        .from("container_lines")
        .upsert(linePayload, { onConflict: "container_id,product_id" });

      if (lineError) {
        fail(`Container line upsert failed for ${candidate.sourceKey} / ${line.sku}: ${lineError.message}`);
      }

      results.linesUpserted += 1;
    }

    if (candidate.needsLifecycleReview || hasIssue) {
      results.containersWithIssues += 1;
    }
  }

  return results;
}

function writeReport(reportPath, content) {
  const resolved = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  return resolved;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    fail("Usage: node scripts/import-old-erp-containers.mjs --input <path-to-containerdrafts.json> [--apply] [--report-out <path>]");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    fail("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const rawRecords = readJsonFile(args.input);
  const candidateCollection = collectCandidates(rawRecords);
  const candidates = candidateCollection.candidates;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const productMap = await loadProductMap(supabase);
  const preview = createPreview(candidates, productMap);
  const comparison = createExpectedComparison(preview.importUnitsByContainer, preview.mappingIssues);
  const sourceKeyConflicts = await getSourceKeyConflicts(
    supabase,
    candidates.map((candidate) => candidate.sourceKey),
  );
  const totalExcluded = Object.values(candidateCollection.exclusionStats).reduce((sum, count) => sum + count, 0);

  console.log("\n=== OLD_ERP Container Import Preview ===\n");
  if (preview.previewRows.length === 0) {
    console.log("No eligible active/open ON_ORDER containers found in the source input.");
  } else {
    console.table(preview.previewRows);
  }

  console.log("Totals:", preview.totals);

  console.log("\nDetection/Exclusion Summary:");
  console.table([
    {
      "Total source records": candidateCollection.sourceRecordCount,
      "Detected with source ID": candidateCollection.detectedWithSourceId,
      "Eligible containers": preview.totals.containerCount,
      "Excluded containers": totalExcluded,
      "Excluded: missing source id": candidateCollection.exclusionStats.missingSourceRecordId,
      "Excluded: removed=true": candidateCollection.exclusionStats.removedTrue,
      "Excluded: inventory state RECEIVED": candidateCollection.exclusionStats.receivedState,
      "Excluded: inventory state not ON_ORDER": candidateCollection.exclusionStats.nonOnOrderState,
      "Excluded: unusable/empty contents": candidateCollection.exclusionStats.emptyOrInvalidContents,
      "Total SKUs (line count)": preview.totals.lineCount,
      "Total unmapped SKU lines": preview.totals.totalUnmappedSkuLines,
      "Total unmapped SKUs (unique)": preview.totals.totalUnmappedSkusUnique,
      "Source-key conflicts": sourceKeyConflicts.length,
    },
  ]);

  if (preview.mappingIssues.length > 0) {
    console.log("\nMapping issues (SKUs not in canonical products):");
    for (const issue of preview.mappingIssues) {
      console.log(`- ${issue.containerNumber} (${issue.sourceKey}): ${issue.skus.join(", ")}`);
    }
  }

  if (sourceKeyConflicts.length > 0) {
    console.log("\nExisting source-key conflicts (idempotent upsert targets):");
    console.table(sourceKeyConflicts.map((row) => ({
      "Container #": row.container_number,
      "Source Key": row.source_key,
      "Existing Container ID": row.id,
    })));
  }

  console.log("\nExpected vs Import Comparison:");
  console.table(comparison.rows);
  console.log("Checksum:", comparison.checksum);
  if (comparison.checksum.expectedContainerCount !== comparison.checksum.expectedTargetCount) {
    console.warn(`Warning: expected container list contains ${comparison.checksum.expectedContainerCount} entries while target count is ${comparison.checksum.expectedTargetCount}.`);
  }

  const reportBase = args.reportOut || `./tmp/import-reports/container-import-preview-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const previewReportPath = writeReport(reportBase, {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    input: path.resolve(args.input),
    detection: {
      sourceRecordCount: candidateCollection.sourceRecordCount,
      detectedWithSourceId: candidateCollection.detectedWithSourceId,
      excluded: candidateCollection.exclusionStats,
      excludedTotal: totalExcluded,
    },
    totals: preview.totals,
    previewRows: preview.previewRows,
    mappingIssues: preview.mappingIssues,
    sourceKeyConflicts,
    expectedComparison: comparison,
  });
  console.log(`\nPreview report: ${previewReportPath}`);

  if (!args.apply) {
    console.log("\nPreview only. Re-run with --apply after approval.");
    return;
  }

  const results = await applyImport(supabase, candidates, productMap);
  const applyReportPath = writeReport(
    previewReportPath.replace("preview", "apply"),
    {
      generatedAt: new Date().toISOString(),
      mode: "apply",
      input: path.resolve(args.input),
      totals: preview.totals,
      results,
      mappingIssues: preview.mappingIssues,
    },
  );

  console.log("\n=== Import Complete ===");
  console.log(results);
  console.log(`Apply report: ${applyReportPath}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
