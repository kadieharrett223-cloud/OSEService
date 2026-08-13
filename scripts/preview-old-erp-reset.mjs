#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  OLD_ERP_ARCHIVE_SOURCE_SYSTEM,
  OLD_ERP_SOURCE_SYSTEM,
  chunkArray,
  createSupabaseAdminClient,
  fail,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

const CANCEL_DENY_CATEGORIES = ["setup_rollback", "cancel_deny_rollback"];
const OPTIONAL_RESET_TABLES = new Set(["order_attachments"]);

function parseArgs(argv) {
  const args = {
    reportOut: "",
    apply: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--report-out") {
      args.reportOut = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--apply") {
      args.apply = true;
    }
  }

  return args;
}

async function fetchIdsByEq(supabase, table, column, value) {
  const pageSize = 1000;
  let from = 0;
  const ids = [];

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("id")
      .eq(column, value)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Could not read ${table}.${column}=${value}: ${error.message}`);
    }

    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row?.id) ids.push(row.id);
    }

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return ids;
}

async function fetchIdsByIn(supabase, table, column, values) {
  if (values.length === 0) return [];
  const ids = [];

  for (const chunk of chunkArray(values, 200)) {
    let from = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select("id")
        .in(column, chunk)
        .range(from, from + pageSize - 1);

      if (error) {
        throw new Error(`Could not read ${table} in ${column}: ${error.message}`);
      }

      const rows = data ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        if (row?.id) ids.push(row.id);
      }

      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }

  return Array.from(new Set(ids));
}

async function fetchIdsByIlike(supabase, table, column, pattern) {
  const pageSize = 1000;
  let from = 0;
  const ids = [];

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("id")
      .ilike(column, pattern)
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Could not read ${table}.${column} ilike ${pattern}: ${error.message}`);
    }

    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row?.id) ids.push(row.id);
    }

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return ids;
}

async function fetchRollupIdsByCategories(supabase, categories) {
  const ids = [];
  for (const category of categories) {
    const categoryIds = await fetchIdsByEq(supabase, "order_history_reason_rollups", "reason_category", category);
    ids.push(...categoryIds);
  }
  return Array.from(new Set(ids));
}

function tableCountEntry(table, ids) {
  return {
    table,
    count: ids.length,
    sampleIds: ids.slice(0, 20),
  };
}

function isMissingTableError(errorMessage) {
  const message = String(errorMessage ?? "").toLowerCase();
  return message.includes("could not find the table")
    || message.includes("schema cache")
    || message.includes("does not exist");
}

function isMissingColumnError(errorMessage) {
  const message = String(errorMessage ?? "").toLowerCase();
  return message.includes("column") && message.includes("does not exist");
}

async function safelyResolveIds({ table, resolver, missingTables, optionalMissingTables, warnings }) {
  try {
    return await resolver();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingTableError(message)) {
      if (OPTIONAL_RESET_TABLES.has(table)) {
        optionalMissingTables.add(table);
        warnings.push(`Optional table unavailable in current schema cache: ${table}`);
      } else {
        missingTables.add(table);
        warnings.push(`Table unavailable in current schema cache: ${table}`);
      }
      return [];
    }
    if (isMissingColumnError(message)) {
      warnings.push(`Column dependency missing for table ${table}: ${message}`);
      return [];
    }
    throw error;
  }
}

export async function buildResetPreview() {
  const supabase = createSupabaseAdminClient();
  const missingTables = new Set();
  const optionalMissingTables = new Set();
  const warnings = [];

  const oldOrderIds = await safelyResolveIds({
    table: "shipping_orders",
    resolver: () => fetchIdsByEq(supabase, "shipping_orders", "source_system", OLD_ERP_SOURCE_SYSTEM),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const oldLineIdsBySource = await safelyResolveIds({
    table: "shipping_order_lines",
    resolver: () => fetchIdsByEq(supabase, "shipping_order_lines", "source_system", OLD_ERP_SOURCE_SYSTEM),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const oldLineIdsByOrders = await safelyResolveIds({
    table: "shipping_order_lines",
    resolver: () => fetchIdsByIn(supabase, "shipping_order_lines", "shipping_order_id", oldOrderIds),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const oldLineIds = Array.from(new Set([...oldLineIdsBySource, ...oldLineIdsByOrders]));

  const oldContainerIds = await safelyResolveIds({
    table: "containers",
    resolver: () => fetchIdsByEq(supabase, "containers", "source_system", OLD_ERP_SOURCE_SYSTEM),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const oldContainerLineIds = await safelyResolveIds({
    table: "container_lines",
    resolver: () => fetchIdsByIn(supabase, "container_lines", "container_id", oldContainerIds),
    missingTables,
    optionalMissingTables,
    warnings,
  });

  const oldOrderAttachmentIds = await safelyResolveIds({
    table: "order_attachments",
    resolver: () => fetchIdsByIn(supabase, "order_attachments", "shipping_order_id", oldOrderIds),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const oldFulfillmentIds = await safelyResolveIds({
    table: "fulfillments",
    resolver: () => fetchIdsByIn(supabase, "fulfillments", "shipping_order_line_id", oldLineIds),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const oldAllocationIds = await safelyResolveIds({
    table: "inventory_allocations",
    resolver: () => fetchIdsByIn(supabase, "inventory_allocations", "shipping_order_line_id", oldLineIds),
    missingTables,
    optionalMissingTables,
    warnings,
  });

  const inventoryTxByLine = await safelyResolveIds({
    table: "inventory_transactions",
    resolver: () => fetchIdsByIn(supabase, "inventory_transactions", "shipping_order_line_id", oldLineIds),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const inventoryTxByContainer = await safelyResolveIds({
    table: "inventory_transactions",
    resolver: () => fetchIdsByIn(supabase, "inventory_transactions", "container_id", oldContainerIds),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const inventoryTxBySourceKey = await safelyResolveIds({
    table: "inventory_transactions",
    resolver: () => fetchIdsByIlike(supabase, "inventory_transactions", "source_event_key", "OLD_ERP%"),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const oldInventoryTransactionIds = Array.from(
    new Set([...inventoryTxByLine, ...inventoryTxByContainer, ...inventoryTxBySourceKey]),
  );

  const oldAliasIds = await safelyResolveIds({
    table: "product_aliases",
    resolver: () => fetchIdsByIlike(supabase, "product_aliases", "source_ref", "OLD_ERP%"),
    missingTables,
    optionalMissingTables,
    warnings,
  });
  const oldProductIds = await safelyResolveIds({
    table: "products",
    resolver: () => fetchIdsByEq(supabase, "products", "source_system", OLD_ERP_SOURCE_SYSTEM),
    missingTables,
    optionalMissingTables,
    warnings,
  });

  const oldArchiveRawIds = await safelyResolveIds({
    table: "order_history_reason_events_raw",
    resolver: () => fetchIdsByEq(
      supabase,
      "order_history_reason_events_raw",
      "source_system",
      OLD_ERP_ARCHIVE_SOURCE_SYSTEM,
    ),
    missingTables,
    optionalMissingTables,
    warnings,
  });

  const oldArchiveRollupIds = await safelyResolveIds({
    table: "order_history_reason_rollups",
    resolver: () => fetchRollupIdsByCategories(supabase, CANCEL_DENY_CATEGORIES),
    missingTables,
    optionalMissingTables,
    warnings,
  });

  const oldSourceArchiveIds = await safelyResolveIds({
    table: "old_erp_source_records",
    resolver: () => fetchIdsByEq(supabase, "old_erp_source_records", "source_system", OLD_ERP_ARCHIVE_SOURCE_SYSTEM),
    missingTables,
    optionalMissingTables,
    warnings,
  });

  const tables = [
    tableCountEntry("order_attachments", oldOrderAttachmentIds),
    tableCountEntry("fulfillments", oldFulfillmentIds),
    tableCountEntry("inventory_allocations", oldAllocationIds),
    tableCountEntry("inventory_transactions", oldInventoryTransactionIds),
    tableCountEntry("shipping_order_lines", oldLineIds),
    tableCountEntry("shipping_orders", oldOrderIds),
    tableCountEntry("container_lines", oldContainerLineIds),
    tableCountEntry("containers", oldContainerIds),
    tableCountEntry("order_history_reason_rollups", oldArchiveRollupIds),
    tableCountEntry("order_history_reason_events_raw", oldArchiveRawIds),
    tableCountEntry("old_erp_source_records", oldSourceArchiveIds),
    tableCountEntry("product_aliases", oldAliasIds),
    tableCountEntry("products", oldProductIds),
  ];

  return {
    generatedAt: new Date().toISOString(),
    mode: "preview-only",
    oldErpScope: {
      sourceSystem: OLD_ERP_SOURCE_SYSTEM,
      archiveSourceSystem: OLD_ERP_ARCHIVE_SOURCE_SYSTEM,
      categories: CANCEL_DENY_CATEGORIES,
    },
    wouldBackupAndDelete: tables,
    totals: {
      tableCount: tables.length,
      rowCount: tables.reduce((sum, entry) => sum + Number(entry.count), 0),
    },
    missingTables: Array.from(missingTables),
    optionalMissingTables: Array.from(optionalMissingTables),
    warnings,
    notes: [
      "No delete statements were executed.",
      "No backup exports were written in preview mode. This report is the exact candidate count list for a future apply step.",
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply) {
    fail("Apply mode is intentionally disabled in this version. Use preview mode only.");
  }

  const report = await buildResetPreview();
  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-reset-preview-${timestampSlug()}.json`);

  const resolvedPath = writeJsonFile(reportPath, report);

  console.log("\n=== OLD_ERP Scoped Reset Preview ===\n");
  for (const row of report.wouldBackupAndDelete) {
    console.log(`${row.table}: ${row.count}`);
  }
  console.log("Totals:", report.totals);
  console.log(`Report: ${resolvedPath}`);
}

const isDirectExecution = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isDirectExecution) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : "Unknown failure");
  });
}
