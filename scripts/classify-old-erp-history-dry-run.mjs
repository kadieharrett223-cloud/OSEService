#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    input: "",
    reportOut: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") {
      args.input = String(argv[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (token === "--report-out") {
      args.reportOut = String(argv[index + 1] ?? "").trim();
      index += 1;
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
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Could not parse input JSON: ${error instanceof Error ? error.message : "Unknown parse error"}`);
  }

  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.records)) return parsed.records;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.data)) return parsed.data;

  fail("Input JSON must be an array or contain records/items/data array.");
  return [];
}

function pick(record, candidates) {
  for (const key of candidates) {
    const value = record?.[key];
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return null;
}

function toText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function toIso(value) {
  const text = toText(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeAuditEvents(record) {
  const rawAudit = pick(record, ["auditLog", "audit_log", "auditTrail", "history"]);
  if (!Array.isArray(rawAudit)) return [];

  return rawAudit
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;

      const action = toText(pick(entry, ["action", "event", "type", "name"]));
      const source = toText(pick(entry, ["source", "origin"]));
      const actor = toText(pick(entry, ["actor", "performedBy", "user", "userName", "by"]));
      const reason = toText(pick(entry, ["reason", "removeReason", "denialReason", "message", "note"]));
      const inventoryRolledBackRaw = pick(entry, ["inventoryRolledBack", "inventory_rolled_back"]);
      const inventoryRolledBack = inventoryRolledBackRaw === true;
      const timestamp = toIso(pick(entry, ["at", "createdAt", "timestamp", "time", "updatedAt"]));

      return {
        action,
        source,
        actor,
        reason,
        inventoryRolledBack,
        timestamp,
        raw: entry,
      };
    })
    .filter((entry) => Boolean(entry))
    .sort((a, b) => {
      const left = a?.timestamp ? Date.parse(a.timestamp) : 0;
      const right = b?.timestamp ? Date.parse(b.timestamp) : 0;
      return left - right;
    });
}

function hasNotes(record) {
  const notes = [
    toText(pick(record, ["notes"])),
    toText(pick(record, ["qboCustomerMemo", "qbo_customer_memo"])),
    toText(pick(record, ["qboPrivateNote", "qbo_private_note"])),
  ].filter(Boolean);

  return notes.length > 0;
}

function hasInventoryRolledBack(record, auditEvents) {
  if (pick(record, ["inventoryRolledBack", "inventory_rolled_back"]) === true) {
    return true;
  }

  return auditEvents.some((entry) => entry.inventoryRolledBack === true);
}

function buildTimeline(auditEvents) {
  return auditEvents.map((entry) => ({
    at: entry.timestamp,
    action: entry.action,
    actor: entry.actor,
    reason: entry.reason,
    source: entry.source,
    inventoryRolledBack: entry.inventoryRolledBack,
  }));
}

function classifyRecord(record) {
  const invoiceNumber = toText(pick(record, ["invoiceNumber", "invoice", "invoice_number"]));
  const customerName = toText(pick(record, ["customerName", "customer", "customer_name", "legacyCustomerName"]));
  const itemCode = toText(pick(record, ["itemCode", "item_code", "sku"]));
  const originalItemCode = toText(pick(record, ["originalItemCode", "original_item_code"]));
  const qboItemName = toText(pick(record, ["qboItemName", "qbo_item_name"]));
  const qtyRaw = pick(record, ["qty", "quantity", "approvedQty", "approved_qty"]);
  const qty = typeof qtyRaw === "number" ? qtyRaw : Number(qtyRaw ?? 0);
  const paymentStatus = toText(pick(record, ["paymentStatus", "payment_status"]));
  const notes = toText(pick(record, ["notes"]));
  const notesUpdatedAt = toIso(pick(record, ["notesUpdatedAt", "notes_updated_at"]));
  const notesUpdatedBy = toText(pick(record, ["notesUpdatedBy", "notes_updated_by"]));
  const qboCustomerMemo = toText(pick(record, ["qboCustomerMemo", "qbo_customer_memo"]));
  const qboPrivateNote = toText(pick(record, ["qboPrivateNote", "qbo_private_note"]));
  const approvalStatus = toText(pick(record, ["approvalStatus", "approval_status"]));
  const queueStatus = toText(pick(record, ["queueStatus", "queue_status"]));
  const deniedAt = toIso(pick(record, ["deniedAt", "denied_at"]));
  const deniedBy = toText(pick(record, ["deniedBy", "denied_by"]));
  const denialReason = toText(pick(record, ["denialReason", "denial_reason"]));
  const removedAt = toIso(pick(record, ["removedAt", "removed_at"]));
  const removedBy = toText(pick(record, ["removedBy", "removed_by"]));
  const removeReason = toText(pick(record, ["removeReason", "remove_reason", "reason"]));
  const invoiceCompletedAt = toIso(pick(record, ["invoiceCompletedAt", "invoice_completed_at"]));
  const createdAt = toIso(pick(record, ["createdAt", "created_at"]));
  const updatedAt = toIso(pick(record, ["updatedAt", "updated_at"]));
  const cosmosId = toText(pick(record, ["id", "_rid", "cosmosId", "cosmos_id"]));

  const auditEvents = normalizeAuditEvents(record);
  const classes = new Set();

  const normalizedQueueStatus = (queueStatus ?? "").toUpperCase();
  const normalizedApprovalStatus = (approvalStatus ?? "").toUpperCase();
  const normalizedDenialReason = (denialReason ?? "").toLowerCase();
  const normalizedRemoveReason = (removeReason ?? "").toLowerCase();

  const deniedEvent = normalizedQueueStatus === "DENIED"
    || normalizedApprovalStatus === "DENIED"
    || Boolean(deniedAt)
    || Boolean(deniedBy)
    || Boolean(denialReason);

  if (deniedEvent) {
    classes.add("denied_any");
    if (normalizedDenialReason.includes("fulfilled")) {
      classes.add("denied_fulfilled");
      classes.add("historical_fulfilled");
    } else {
      classes.add("denied_other");
    }
  }

  const removedEvent = normalizedQueueStatus === "REMOVED"
    || Boolean(removedAt)
    || Boolean(removedBy)
    || Boolean(removeReason)
    || auditEvents.some((entry) => (entry.action ?? "").toLowerCase().includes("remove"));

  const isCsvMigrationArtifact = normalizedRemoveReason.startsWith("cleared by invoice csv import")
    || auditEvents.some((entry) => (entry.source ?? "").toLowerCase() === "invoice-csv-import-replace");

  const isQboSuperseded = normalizedRemoveReason === "replaced by updated quickbooks invoice";

  if (removedEvent) {
    if (isCsvMigrationArtifact) {
      classes.add("removed_csv_migration_artifact");
    } else if (isQboSuperseded) {
      classes.add("removed_superseded_qbo");
    } else if (normalizedRemoveReason.includes("duplicate")) {
      classes.add("removed_duplicate");
      classes.add("removed_manual_genuine");
    } else if (normalizedRemoveReason.includes("dont need") || normalizedRemoveReason.includes("no longer needed") || normalizedRemoveReason.includes("cancel")) {
      classes.add("removed_cancelled_no_longer_needed");
      classes.add("removed_manual_genuine");
    } else if (normalizedRemoveReason.includes("fake") || normalizedRemoveReason.includes("test")) {
      classes.add("removed_invalid_test");
      classes.add("removed_manual_genuine");
    } else if (normalizedRemoveReason.includes("not a part") || normalizedRemoveReason.includes("non-inventory")) {
      classes.add("removed_invalid_non_inventory");
      classes.add("removed_manual_genuine");
    } else {
      classes.add("removed_unknown");
      if (normalizedRemoveReason) {
        classes.add("unknown_unclassified_reason");
      }
    }
  }

  if (invoiceCompletedAt || normalizedQueueStatus === "FULFILLED") {
    classes.add("historical_fulfilled");
  }

  const notesPresent = hasNotes(record);
  if (notesPresent) {
    classes.add("has_notes");
  }

  const inventoryRolledBack = hasInventoryRolledBack(record, auditEvents);
  if (inventoryRolledBack) {
    classes.add("inventory_rolled_back_true");
  }

  const simplified = {
    cosmosId,
    invoiceNumber,
    customerName,
    itemCode,
    originalItemCode,
    qboItemName,
    qty: Number.isFinite(qty) ? qty : null,
    paymentStatus,
    notes,
    notesUpdatedAt,
    notesUpdatedBy,
    qboCustomerMemo,
    qboPrivateNote,
    approvalStatus,
    queueStatus,
    deniedAt,
    deniedBy,
    denialReason,
    removedAt,
    removedBy,
    removeReason,
    invoiceCompletedAt,
    createdAt,
    updatedAt,
    auditLog: buildTimeline(auditEvents),
    classification: Array.from(classes.values()).sort(),
  };

  return {
    classes,
    simplified,
  };
}

function pushExample(exampleMap, key, example) {
  if (!exampleMap[key]) {
    exampleMap[key] = [];
  }

  if (exampleMap[key].length < 10) {
    exampleMap[key].push(example);
  }
}

function summarize(records) {
  const counters = {
    totalRawRecords: records.length,
    uniqueInvoices: 0,
    deniedCount: 0,
    genuineManualCancellationRemovalCount: 0,
    fulfilledCount: 0,
    duplicateCount: 0,
    supersededByQboCount: 0,
    csvMigrationArtifactCount: 0,
    invalidTestNotAPartCount: 0,
    recordsWithNotesCount: 0,
    recordsWithInventoryRolledBackTrueCount: 0,
    unknownUnclassifiedReasonsCount: 0,
  };

  const examples = {};
  const uniqueInvoices = new Set();

  for (const record of records) {
    const { classes, simplified } = classifyRecord(record);

    if (simplified.invoiceNumber) {
      uniqueInvoices.add(simplified.invoiceNumber.toUpperCase());
    }

    if (classes.has("denied_any")) counters.deniedCount += 1;
    if (classes.has("removed_manual_genuine")) counters.genuineManualCancellationRemovalCount += 1;
    if (classes.has("historical_fulfilled")) counters.fulfilledCount += 1;
    if (classes.has("removed_duplicate")) counters.duplicateCount += 1;
    if (classes.has("removed_superseded_qbo")) counters.supersededByQboCount += 1;
    if (classes.has("removed_csv_migration_artifact")) counters.csvMigrationArtifactCount += 1;
    if (classes.has("removed_invalid_test") || classes.has("removed_invalid_non_inventory")) {
      counters.invalidTestNotAPartCount += 1;
    }
    if (classes.has("has_notes")) counters.recordsWithNotesCount += 1;
    if (classes.has("inventory_rolled_back_true")) counters.recordsWithInventoryRolledBackTrueCount += 1;
    if (classes.has("unknown_unclassified_reason")) counters.unknownUnclassifiedReasonsCount += 1;

    for (const className of classes.values()) {
      pushExample(examples, className, simplified);
    }
  }

  counters.uniqueInvoices = uniqueInvoices.size;

  return {
    counts: counters,
    examples,
  };
}

function writeReport(reportPath, payload) {
  const resolved = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    fail("Usage: node scripts/classify-old-erp-history-dry-run.mjs --input <invoice-queue-export.json> [--report-out <path>]");
  }

  const records = readJsonFile(args.input);
  const report = summarize(records);

  const reportFile = args.reportOut || `tmp/import-reports/old-erp-history-dry-run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const reportPath = writeReport(reportFile, {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    input: path.resolve(args.input),
    classificationRulesVersion: "1.0",
    counts: report.counts,
    examplesByClassification: report.examples,
    safety: {
      writesPerformed: false,
      notes: "Dry-run classification only. No Supabase writes, no inventory mutation, no active demand mutation.",
    },
  });

  console.log("\n=== OLD ERP History Dry-Run Classification Report ===\n");
  console.log(report.counts);
  console.log(`\nReport written to: ${reportPath}`);
  console.log("No database writes were performed.");
}

main();
