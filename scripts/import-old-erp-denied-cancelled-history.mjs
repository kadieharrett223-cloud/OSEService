#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

const EXPECTED_SETUP_ROLLBACK_ROWS = 353;
const EXPECTED_CANCEL_DENY_ROWS = 88;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    input: "",
    apply: false,
    reportOut: "",
    strictCounts: true,
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
    if (token === "--allow-count-drift") {
      args.strictCounts = false;
    }
  }

  return args;
}

function readJsonFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    fail(`Input file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf8").trim();
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

function normalizeText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeInvoiceNumber(value) {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function normalizeItemCode(value) {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function normalizeReason(value) {
  const text = normalizeText(value);
  if (!text) return null;
  return text.replace(/\s+/g, " ");
}

function toIsoTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function resolveReasonCategory(rawReasonCategory, reason) {
  const normalizedCategory = normalizeText(rawReasonCategory);
  if (normalizedCategory === "setup_rollback" || normalizedCategory === "cancel_deny_rollback") {
    return normalizedCategory;
  }

  const normalizedReason = String(reason ?? "").toLowerCase();
  if (normalizedReason.startsWith("queue item removal rollback:")) {
    return "cancel_deny_rollback";
  }
  if (normalizedReason.startsWith("rollback prior setup invoice import")) {
    return "setup_rollback";
  }

  return null;
}

function assertRequiredSchema(record) {
  const sourceId = normalizeText(record?.id);
  const invoiceNumber = normalizeText(record?.invoiceNumber);
  const itemCode = normalizeText(record?.itemCode);
  const reason = normalizeText(record?.reason);
  const reasonCategory = resolveReasonCategory(record?.reasonCategory, reason);

  if (!sourceId || !invoiceNumber || !itemCode || !reasonCategory || !reason) {
    return null;
  }

  if (reasonCategory !== "setup_rollback" && reasonCategory !== "cancel_deny_rollback") {
    return null;
  }

  return {
    sourceId,
    invoiceNumber,
    itemCode,
    reasonCategory,
    reason,
    actor: normalizeText(record?.actor),
    adjustedAt: toIsoTimestamp(record?.adjustedAt),
    createdAt: toIsoTimestamp(record?.createdAt),
    raw: record,
  };
}

function validateAndNormalize(records) {
  const normalized = [];
  let invalidRows = 0;

  for (const record of records) {
    const row = assertRequiredSchema(record);
    if (!row) {
      invalidRows += 1;
      continue;
    }

    const invoiceNumberNormalized = normalizeInvoiceNumber(row.invoiceNumber);
    const itemCodeNormalized = normalizeItemCode(row.itemCode);
    const reasonNormalized = normalizeReason(row.reason);

    if (!invoiceNumberNormalized || !itemCodeNormalized || !reasonNormalized) {
      invalidRows += 1;
      continue;
    }

    normalized.push({
      ...row,
      invoiceNumberNormalized,
      itemCodeNormalized,
      reasonNormalized,
    });
  }

  return { normalized, invalidRows };
}

function splitByCategory(records) {
  const setupRollback = [];
  const cancelDenyRollback = [];

  for (const record of records) {
    if (record.reasonCategory === "setup_rollback") {
      setupRollback.push(record);
      continue;
    }
    if (record.reasonCategory === "cancel_deny_rollback") {
      cancelDenyRollback.push(record);
    }
  }

  return { setupRollback, cancelDenyRollback };
}

function buildRollups(records) {
  const grouped = new Map();

  for (const row of records) {
    const key = [
      row.invoiceNumberNormalized,
      row.itemCodeNormalized,
      row.reasonCategory,
      row.reasonNormalized,
    ].join("|");

    const existing = grouped.get(key) ?? {
      reasonCategory: row.reasonCategory,
      invoiceNumberNormalized: row.invoiceNumberNormalized,
      itemCodeNormalized: row.itemCodeNormalized,
      reasonNormalized: row.reasonNormalized,
      canonicalInvoiceNumber: row.invoiceNumber,
      canonicalItemCode: row.itemCode,
      canonicalReason: row.reason,
      firstSeenAt: row.createdAt,
      lastSeenAt: row.createdAt,
      occurrenceCount: 0,
      actors: new Set(),
    };

    existing.occurrenceCount += 1;
    if (row.actor) existing.actors.add(row.actor);

    if (row.createdAt && (!existing.firstSeenAt || row.createdAt < existing.firstSeenAt)) {
      existing.firstSeenAt = row.createdAt;
    }
    if (row.createdAt && (!existing.lastSeenAt || row.createdAt > existing.lastSeenAt)) {
      existing.lastSeenAt = row.createdAt;
    }

    grouped.set(key, existing);
  }

  return Array.from(grouped.values()).map((entry) => ({
    reason_category: entry.reasonCategory,
    invoice_number_normalized: entry.invoiceNumberNormalized,
    item_code_normalized: entry.itemCodeNormalized,
    reason_normalized: entry.reasonNormalized,
    canonical_invoice_number: entry.canonicalInvoiceNumber,
    canonical_item_code: entry.canonicalItemCode,
    canonical_reason: entry.canonicalReason,
    first_seen_at: entry.firstSeenAt,
    last_seen_at: entry.lastSeenAt,
    occurrence_count: entry.occurrenceCount,
    actors: Array.from(entry.actors),
  }));
}

function writeReport(reportPath, content) {
  const resolved = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  return resolved;
}

async function assertRequiredSchemaTables(supabase) {
  const { error: rawError } = await supabase
    .from("order_history_reason_events_raw")
    .select("id, reason_category, raw_payload")
    .limit(1);

  if (rawError) {
    fail(`Missing order_history_reason_events_raw table/columns. Apply migration 202608130001_historical_denied_cancelled_archive.sql first. (${rawError.message})`);
  }

  const { error: rollupError } = await supabase
    .from("order_history_reason_rollups")
    .select("id, reason_category, occurrence_count")
    .limit(1);

  if (rollupError) {
    fail(`Missing order_history_reason_rollups table/columns. Apply migration 202608130001_historical_denied_cancelled_archive.sql first. (${rollupError.message})`);
  }
}

async function insertRawRows(supabase, importBatchId, rows) {
  const payload = rows.map((row) => ({
    import_batch_id: importBatchId,
    source_system: "OLD_ERP_COSMOS",
    source_container: "InventoryAdjustments",
    source_id: row.sourceId,
    invoice_number: row.invoiceNumber,
    invoice_number_normalized: row.invoiceNumberNormalized,
    item_code: row.itemCode,
    item_code_normalized: row.itemCodeNormalized,
    reason_category: row.reasonCategory,
    reason: row.reason,
    reason_normalized: row.reasonNormalized,
    actor: row.actor,
    adjusted_at: row.adjustedAt,
    created_at: row.createdAt,
    raw_payload: row.raw,
  }));

  if (payload.length === 0) return;

  const { error } = await supabase
    .from("order_history_reason_events_raw")
    .insert(payload);

  if (error) {
    fail(`Could not insert raw archive rows: ${error.message}`);
  }
}

async function rebuildRollups(supabase) {
  const { data: rawRows, error } = await supabase
    .from("order_history_reason_events_raw")
    .select("reason_category, invoice_number, invoice_number_normalized, item_code, item_code_normalized, reason, reason_normalized, actor, created_at")
    .in("reason_category", ["setup_rollback", "cancel_deny_rollback"]);

  if (error) {
    fail(`Could not read raw archive rows for rollups: ${error.message}`);
  }

  const normalizedRows = (rawRows ?? []).map((row) => ({
    reasonCategory: row.reason_category,
    invoiceNumber: row.invoice_number,
    invoiceNumberNormalized: row.invoice_number_normalized,
    itemCode: row.item_code,
    itemCodeNormalized: row.item_code_normalized,
    reason: row.reason,
    reasonNormalized: row.reason_normalized,
    actor: row.actor,
    createdAt: row.created_at,
  }));

  const rollups = buildRollups(normalizedRows);

  const { error: deleteError } = await supabase
    .from("order_history_reason_rollups")
    .delete()
    .gte("occurrence_count", 1);

  if (deleteError) {
    fail(`Could not reset rollups before rebuild: ${deleteError.message}`);
  }

  if (rollups.length === 0) return 0;

  const { error: insertError } = await supabase
    .from("order_history_reason_rollups")
    .insert(rollups);

  if (insertError) {
    fail(`Could not insert rollups: ${insertError.message}`);
  }

  return rollups.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    fail("Usage: node scripts/import-old-erp-denied-cancelled-history.mjs --input <categorized-export.json> [--apply] [--report-out <path>] [--allow-count-drift]");
  }

  const rawRecords = readJsonFile(args.input);
  const { normalized, invalidRows } = validateAndNormalize(rawRecords);
  const { setupRollback, cancelDenyRollback } = splitByCategory(normalized);

  if (args.strictCounts) {
    if (setupRollback.length !== EXPECTED_SETUP_ROLLBACK_ROWS) {
      fail(`Expected ${EXPECTED_SETUP_ROLLBACK_ROWS} setup_rollback rows, got ${setupRollback.length}. Use --allow-count-drift to override.`);
    }
    if (cancelDenyRollback.length !== EXPECTED_CANCEL_DENY_ROWS) {
      fail(`Expected ${EXPECTED_CANCEL_DENY_ROWS} cancel_deny_rollback rows, got ${cancelDenyRollback.length}. Use --allow-count-drift to override.`);
    }
  }

  const preview = {
    sourceRecordCount: rawRecords.length,
    validRecordCount: normalized.length,
    invalidRecordCount: invalidRows,
    setupRollbackCount: setupRollback.length,
    cancelDenyRollbackCount: cancelDenyRollback.length,
    sampleCancelDenyRows: cancelDenyRollback.slice(0, 10).map((row) => ({
      sourceId: row.sourceId,
      invoiceNumber: row.invoiceNumber,
      itemCode: row.itemCode,
      reason: row.reason,
      actor: row.actor,
      createdAt: row.createdAt,
    })),
  };

  const reportBase = args.reportOut || `./tmp/import-reports/denied-cancelled-history-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const previewReportPath = writeReport(reportBase, {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    input: path.resolve(args.input),
    strictCounts: args.strictCounts,
    expectedCounts: {
      setupRollbackCount: EXPECTED_SETUP_ROLLBACK_ROWS,
      cancelDenyRollbackCount: EXPECTED_CANCEL_DENY_ROWS,
    },
    preview,
  });

  console.log("\n=== Denied/Cancelled Historical Archive Preview ===\n");
  console.log(preview);
  console.log(`Preview report: ${previewReportPath}`);

  if (!args.apply) {
    console.log("Preview only. Re-run with --apply to write archive tables.");
    return;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    fail("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  await assertRequiredSchemaTables(supabase);

  const importBatchId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;

  // Raw ingestion intentionally preserves every source row and does not deduplicate.
  await insertRawRows(supabase, importBatchId, normalized);
  const rollupCount = await rebuildRollups(supabase);

  const results = {
    importBatchId,
    rawRowsInserted: normalized.length,
    setupRollbackRawRowsInserted: setupRollback.length,
    cancelDenyRawRowsInserted: cancelDenyRollback.length,
    cancelDenyBusinessRowsVisible: cancelDenyRollback.length,
    rollupRowsRebuilt: rollupCount,
  };

  const applyReportPath = writeReport(
    previewReportPath.replace("preview", "apply"),
    {
      generatedAt: new Date().toISOString(),
      mode: "apply",
      input: path.resolve(args.input),
      preview,
      results,
    },
  );

  console.log("\n=== Denied/Cancelled Historical Archive Import Complete ===");
  console.log(results);
  console.log(`Apply report: ${applyReportPath}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
