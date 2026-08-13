#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  loadCosmosSources,
  normalizeText,
  pickFirst,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

const SOURCE_SYSTEM = "OLD_ERP_COSMOS";
const CONTAINERS = [
  ["Products", "products"],
  ["WarehouseInvoices", "warehouseInvoices"],
  ["InventoryAdjustments", "inventoryAdjustments"],
  ["ContainerDrafts", "containerDrafts"],
  ["InvoiceQueueItems", "invoiceQueueItems"],
];

function parseArgs(argv) {
  const args = { exportsDir: "tmp/exports", apply: false, reportOut: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--exports-dir") { args.exportsDir = String(argv[i + 1] ?? "").trim() || args.exportsDir; i += 1; }
    if (token === "--apply") args.apply = true;
    if (token === "--report-out") { args.reportOut = String(argv[i + 1] ?? "").trim(); i += 1; }
  }
  return args;
}

function sourceId(record, container, index) {
  const direct = normalizeText(pickFirst(record, ["id", "_id", "recordId", "queueItemId", "containerDraftId"]));
  if (direct) return direct;
  const digest = crypto.createHash("sha256").update(JSON.stringify(record)).digest("hex");
  return `${container}:${index + 1}:${digest.slice(0, 24)}`;
}

function toIsoTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function mapRecords(sources) {
  const rows = [];
  const duplicateSourceKeys = [];

  for (const [container, property] of CONTAINERS) {
    const seen = new Set();
    for (const [index, record] of sources[property].entries()) {
      const recordId = sourceId(record, container, index);
      const key = `${SOURCE_SYSTEM}:${container}:${recordId}`;
      if (seen.has(key)) {
        duplicateSourceKeys.push(key);
        continue;
      }
      seen.add(key);
      rows.push({
        source_system: SOURCE_SYSTEM,
        source_container: container,
        source_record_id: recordId,
        source_key: key,
        raw_payload: record,
        source_created_at: toIsoTimestamp(record?.createdAt),
        source_updated_at: toIsoTimestamp(record?.updatedAt),
      });
    }
  }

  return { rows, duplicateSourceKeys };
}

async function applyRows(supabase, rows) {
  let insertedOrUpdated = 0;
  for (let offset = 0; offset < rows.length; offset += 250) {
    const batch = rows.slice(offset, offset + 250);
    const { error } = await supabase
      .from("old_erp_source_records")
      .upsert(batch, { onConflict: "source_system,source_container,source_record_id" });
    if (error) fail(`Could not archive OLD_ERP source batch at ${offset}: ${error.message}`);
    insertedOrUpdated += batch.length;
  }
  return { insertedOrUpdated };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadCosmosSources({ exportsDir: args.exportsDir });
  const mapped = mapRecords(sources);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    sourceFiles: sources.files,
    sourceCounts: Object.fromEntries(CONTAINERS.map(([container, property]) => [container, sources[property].length])),
    plannedArchiveRows: mapped.rows.length,
    duplicateSourceKeyCount: mapped.duplicateSourceKeys.length,
    duplicateSourceKeys: mapped.duplicateSourceKeys.slice(0, 100),
    notes: [
      "Raw payloads are preserved unchanged.",
      "This archive does not create inventory transactions or allocations.",
      "Apply mode only writes old_erp_source_records and is idempotent by source identity.",
    ],
  };

  if (args.apply) {
    const supabase = createSupabaseAdminClient();
    report.applyResults = await applyRows(supabase, mapped.rows);
  }

  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-source-archive-${timestampSlug()}.json`);
  const resolved = writeJsonFile(reportPath, report);
  console.log("\n=== OLD_ERP Complete Source Archive ===\n");
  console.log(report);
  console.log(`Report: ${resolved}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown source archive failure"));
