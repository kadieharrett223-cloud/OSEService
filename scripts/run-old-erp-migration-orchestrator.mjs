#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { findLatestExport, timestampSlug, writeJsonFile } from "./old-erp-migration-utils.mjs";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    exportsDir: "tmp/exports",
    reportOut: "",
    refreshExports: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--exports-dir") {
      args.exportsDir = String(argv[i + 1] ?? "").trim() || args.exportsDir;
      i += 1;
      continue;
    }
    if (token === "--report-out") {
      args.reportOut = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--refresh-exports") {
      args.refreshExports = true;
    }
  }

  return args;
}

function runNodeCommand(args, label) {
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr ?? "").trim();
    const stdout = String(result.stdout ?? "").trim();
    fail(`${label} failed. ${stderr || stdout || "No output"}`);
  }

  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function refreshCosmosExports() {
  const containers = [
    "Products",
    "WarehouseInvoices",
    "InventoryAdjustments",
    "ContainerDrafts",
    "InvoiceQueueItems",
  ];

  const outputs = [];

  for (const container of containers) {
    const args = [
      "--env-file=.env.local",
      "scripts/export-azure-cosmos.mjs",
      container,
    ];

    const result = runNodeCommand(args, `Cosmos export for ${container}`);
    outputs.push({
      container,
      stdoutTail: result.stdout.split(/\r?\n/).slice(-8),
    });
  }

  return outputs;
}

function validateLatestExports(exportsDir) {
  const containers = [
    "Products",
    "WarehouseInvoices",
    "InventoryAdjustments",
    "ContainerDrafts",
    "InvoiceQueueItems",
  ];

  const files = {};
  for (const container of containers) {
    files[container] = findLatestExport(exportsDir, container);
  }

  return files;
}

function parseReadinessFromReport(reportPath) {
  const raw = fs.readFileSync(reportPath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    readiness: parsed.readiness,
    sourceCounts: parsed.sourceCounts,
    plannedTargetCounts: parsed.plannedTargetCounts,
    report: parsed,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun) {
    fail("This orchestrator is dry-run only. Re-run with --dry-run.");
  }

  const startedAt = new Date().toISOString();
  const phaseLog = [];

  if (args.refreshExports) {
    const exportOutputs = refreshCosmosExports();
    phaseLog.push({
      phase: "export-cosmos",
      mode: "read-only",
      status: "completed",
      details: exportOutputs,
    });
  } else {
    phaseLog.push({
      phase: "export-cosmos",
      mode: "read-only",
      status: "skipped",
      details: "Using latest existing Cosmos exports.",
    });
  }

  const sourceFiles = validateLatestExports(args.exportsDir);
  phaseLog.push({
    phase: "validate-source-exports",
    status: "completed",
    details: sourceFiles,
  });

  const masterReportPath = path.resolve(`tmp/import-reports/old-erp-master-reconciliation-${timestampSlug()}.json`);
  runNodeCommand([
    "scripts/report-old-erp-master-reconciliation.mjs",
    "--exports-dir",
    args.exportsDir,
    "--report-out",
    masterReportPath,
  ], "Master reconciliation");

  const master = parseReadinessFromReport(masterReportPath);

  phaseLog.push({
    phase: "validate-and-reconcile",
    status: "completed",
    details: {
      readiness: master.readiness,
      sourceCounts: master.sourceCounts,
      plannedTargetCounts: master.plannedTargetCounts,
      masterReportPath,
    },
  });

  phaseLog.push({
    phase: "backup-reset-import-plan",
    status: "planned-only",
    details: "Reset, backup, and import apply steps are not executed in dry-run mode.",
  });

  const orchestratorReport = {
    generatedAt: new Date().toISOString(),
    startedAt,
    mode: "dry-run-only",
    phases: phaseLog,
    readiness: master.readiness,
    sourceCounts: master.sourceCounts,
    plannedTargetCounts: master.plannedTargetCounts,
    masterReportPath,
    notes: [
      "No Supabase delete/insert/update statements executed.",
      "No Azure writes executed.",
      "This command prepares the full future pipeline sequence but runs validation/reporting only.",
    ],
  };

  const outPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-orchestrator-dry-run-${timestampSlug()}.json`);

  writeJsonFile(outPath, orchestratorReport);

  console.log("\n=== OLD_ERP Migration Orchestrator (Dry Run) ===\n");
  console.log("Readiness:", orchestratorReport.readiness);
  console.log("Master report:", masterReportPath);
  console.log("Orchestrator report:", outPath);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
