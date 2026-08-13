#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { calculateOpeningStateFromSources } from "./calculate-old-erp-opening-state.mjs";
import { buildCustomerResolutionPreview } from "./preview-old-erp-customer-resolution.mjs";
import { buildResetPreview } from "./preview-old-erp-reset.mjs";
import {
  createSupabaseAdminClient,
  fail,
  findLatestExport,
  loadCosmosSources,
  normalizeSku,
  normalizeSkuKey,
  normalizeText,
  parseContainerLines,
  pickFirst,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

function parseArgs(argv) {
  const args = {
    exportsDir: "tmp/exports",
    reportOut: "",
    productsFile: "",
    warehouseInvoicesFile: "",
    inventoryAdjustmentsFile: "",
    containerDraftsFile: "",
    invoiceQueueItemsFile: "",
    includeFocusSkus: ["4032S", "4PHR-9X"],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
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
    if (token === "--products-file") {
      args.productsFile = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--warehouse-invoices-file") {
      args.warehouseInvoicesFile = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--inventory-adjustments-file") {
      args.inventoryAdjustmentsFile = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--container-drafts-file") {
      args.containerDraftsFile = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--invoice-queue-items-file") {
      args.invoiceQueueItemsFile = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
    if (token === "--focus-skus") {
      const raw = String(argv[i + 1] ?? "").trim();
      args.includeFocusSkus = raw
        .split(",")
        .map((value) => normalizeSku(value))
        .filter(Boolean);
      i += 1;
      continue;
    }
  }

  return args;
}

async function loadSupabaseProductsAndAliases(supabase) {
  let products = [];
  let productsError = null;

  ({ data: products, error: productsError } = await supabase
    .from("products")
    .select("id, sku, source_system, source_key"));

  if (productsError && String(productsError.message ?? "").toLowerCase().includes("column") && String(productsError.message ?? "").toLowerCase().includes("does not exist")) {
    ({ data: products, error: productsError } = await supabase
      .from("products")
      .select("id, sku"));
  }

  if (productsError) {
    fail(`Could not read products: ${productsError.message}`);
  }

  const { data: aliases, error: aliasesError } = await supabase
    .from("product_aliases")
    .select("id, product_id, alias, source_ref");
  if (aliasesError) {
    fail(`Could not read product_aliases: ${aliasesError.message}`);
  }

  const map = new Map();
  for (const product of products ?? []) {
    const sku = normalizeSku(product.sku);
    const skuKey = normalizeSkuKey(product.sku);
    if (sku) map.set(sku, product.id);
    if (skuKey) map.set(skuKey, product.id);
  }

  for (const alias of aliases ?? []) {
    const aliasSku = normalizeSku(alias.alias);
    const aliasKey = normalizeSkuKey(alias.alias);
    if (aliasSku) map.set(aliasSku, alias.product_id);
    if (aliasKey) map.set(aliasKey, alias.product_id);
  }

  return {
    products: products ?? [],
    aliases: aliases ?? [],
    map,
  };
}

function collectSourceSkus(sources, openingState) {
  const sourceSkus = new Set();

  for (const product of sources.products) {
    const sku = normalizeSku(pickFirst(product, ["sku", "itemCode", "partNumber"]));
    if (sku) sourceSkus.add(sku);
  }

  for (const row of openingState.activeOrderLines) {
    if (row.sku) sourceSkus.add(row.sku);
  }

  for (const draft of sources.containerDrafts) {
    const lines = parseContainerLines(draft);
    for (const line of lines) {
      if (line.sku) sourceSkus.add(line.sku);
    }
  }

  return Array.from(sourceSkus).sort((a, b) => a.localeCompare(b));
}

function collectUnmappedSkus(sourceSkus, productMap) {
  const unmapped = [];
  for (const sku of sourceSkus) {
    const skuKey = normalizeSkuKey(sku);
    const mapped = productMap.has(sku) || (skuKey ? productMap.has(skuKey) : false);
    if (!mapped) unmapped.push(sku);
  }
  return unmapped;
}

function duplicateConflictSummary(openingState) {
  const byQueueItemId = new Map();
  const byInvoiceSku = new Map();

  for (const row of openingState.activeOrderLines) {
    const queueItemId = row.queueItemId ?? "NO_QUEUE_ID";
    byQueueItemId.set(queueItemId, (byQueueItemId.get(queueItemId) ?? 0) + 1);

    const invoiceSkuKey = `${row.invoiceNumber ?? "NO_INVOICE"}|${row.sku}`;
    byInvoiceSku.set(invoiceSkuKey, (byInvoiceSku.get(invoiceSkuKey) ?? 0) + 1);
  }

  const duplicateQueueItemIds = Array.from(byQueueItemId.entries())
    .filter(([key, count]) => key !== "NO_QUEUE_ID" && count > 1)
    .map(([queueItemId, count]) => ({ queueItemId, count }));

  const duplicateInvoiceSkuPairs = Array.from(byInvoiceSku.entries())
    .filter(([, count]) => count > 1)
    .slice(0, 200)
    .map(([key, count]) => {
      const [invoiceNumber, sku] = key.split("|");
      return {
        invoiceNumber,
        sku,
        count,
      };
    });

  return {
    duplicateQueueItemIdCount: duplicateQueueItemIds.length,
    duplicateInvoiceSkuPairCount: duplicateInvoiceSkuPairs.length,
    duplicateQueueItemIds: duplicateQueueItemIds.slice(0, 50),
    duplicateInvoiceSkuPairs: duplicateInvoiceSkuPairs.slice(0, 100),
  };
}

function focusSkuViews(openingState, focusSkus) {
  const bySku = new Map();
  for (const row of openingState.skuOpening) {
    bySku.set(row.sku, row);
  }

  return focusSkus.map((focusSku) => {
    const skuSummary = bySku.get(focusSku) ?? null;
    const queueLines = openingState.activeOrderLines
      .filter((line) => line.sku === focusSku)
      .sort((a, b) => {
        const aPos = Number.isFinite(a.queuePosition) ? a.queuePosition : Number.MAX_SAFE_INTEGER;
        const bPos = Number.isFinite(b.queuePosition) ? b.queuePosition : Number.MAX_SAFE_INTEGER;
        return aPos - bPos;
      })
      .slice(0, 200);

    return {
      sku: focusSku,
      summary: skuSummary,
      queueLines,
      equation: skuSummary
        ? `${skuSummary.warehouseQty} + ${skuSummary.incomingQty} - ${skuSummary.committedTotal} = ${skuSummary.availableTotal}`
        : "SKU not found in opening-state table",
    };
  });
}

function readLatestHistoryDryRun(importReportsDir) {
  const resolvedDir = path.resolve(importReportsDir);
  if (!fs.existsSync(resolvedDir)) {
    return null;
  }

  const files = fs.readdirSync(resolvedDir)
    .filter((name) => name.startsWith("old-erp-history-dry-run-") && name.endsWith(".json"))
    .map((name) => {
      const fullPath = path.join(resolvedDir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (files.length === 0) return null;

  const raw = fs.readFileSync(files[0].fullPath, "utf8");
  const parsed = JSON.parse(raw);

  return {
    path: files[0].fullPath,
    counts: parsed?.counts ?? null,
  };
}

function buildReadinessDecision({ unmappedSkus, customerPreview, openingState, resetPreview }) {
  const blockers = [];

  if (unmappedSkus.length > 0) {
    blockers.push(`Unmapped SKUs present: ${unmappedSkus.length}`);
  }

  if ((customerPreview.summary?.ambiguous ?? 0) > 0) {
    blockers.push(`Ambiguous customer groups: ${customerPreview.summary.ambiguous}`);
  }

  if ((customerPreview.summary?.orderLinesWithMissingCustomer ?? 0) > 0) {
    blockers.push(`Order lines without deterministic customer resolution: ${customerPreview.summary.orderLinesWithMissingCustomer}`);
  }

  if ((openingState.ambiguousAssignments?.length ?? 0) > 0) {
    blockers.push(`Ambiguous container assignments: ${openingState.ambiguousAssignments.length}`);
  }

  if ((resetPreview.totals?.rowCount ?? 0) <= 0) {
    blockers.push("Reset preview did not detect OLD_ERP rows in Supabase; verify source tagging and prior imports.");
  }

  if ((resetPreview.missingTables?.length ?? 0) > 0) {
    blockers.push(`Reset preview missing tables in schema cache: ${resetPreview.missingTables.join(", ")}`);
  }

  return {
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    blockers,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const sources = loadCosmosSources({
    exportsDir: args.exportsDir,
    explicitFiles: {
      Products: args.productsFile,
      WarehouseInvoices: args.warehouseInvoicesFile,
      InventoryAdjustments: args.inventoryAdjustmentsFile,
      ContainerDrafts: args.containerDraftsFile,
      InvoiceQueueItems: args.invoiceQueueItemsFile,
    },
  });

  const openingState = calculateOpeningStateFromSources(sources);
  const customerPreview = await buildCustomerResolutionPreview(sources);
  const resetPreview = await buildResetPreview();

  const supabase = createSupabaseAdminClient();
  const supabaseProducts = await loadSupabaseProductsAndAliases(supabase);
  const sourceSkus = collectSourceSkus(sources, openingState);
  const unmappedSkus = collectUnmappedSkus(sourceSkus, supabaseProducts.map);
  const duplicateSummary = duplicateConflictSummary(openingState);
  const historyDryRun = readLatestHistoryDryRun("tmp/import-reports");

  const sourceCounts = {
    products: sources.products.length,
    warehouseInvoices: sources.warehouseInvoices.length,
    inventoryAdjustments: sources.inventoryAdjustments.length,
    containerDrafts: sources.containerDrafts.length,
    invoiceQueueItems: sources.invoiceQueueItems.length,
  };

  const plannedTargetCounts = {
    productsFromSource: sourceCounts.products,
    aliasesExisting: supabaseProducts.aliases.length,
    activeContainers: openingState.summary.activeContainerCount,
    activeDemandLines: openingState.summary.activeDemandLineCount,
    sourceCustomerGroups: customerPreview.summary.sourceCustomerGroups,
  };

  const readiness = buildReadinessDecision({
    unmappedSkus,
    customerPreview,
    openingState,
    resetPreview,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    sourceFiles: sources.files,
    readiness,
    sourceCounts,
    plannedTargetCounts,
    inventoryReconciliation: {
      summary: openingState.summary,
      skuOpening: openingState.skuOpening,
      focusSkus: focusSkuViews(openingState, args.includeFocusSkus),
    },
    containerReconciliation: {
      containerSkuRows: openingState.containerOpening,
      ambiguousAssignments: openingState.ambiguousAssignments,
    },
    customerOrderReconciliation: {
      customerSummary: customerPreview.summary,
      unresolvedCustomers: customerPreview.unresolvedCustomers,
      ambiguousCustomers: customerPreview.ambiguousCustomers,
      ordersGrouped: openingState.ordersGrouped,
    },
    mappingsAndConflicts: {
      sourceSkuCount: sourceSkus.length,
      unmappedSkuCount: unmappedSkus.length,
      unmappedSkus,
      duplicateSummary,
    },
    historicalArchive: {
      latestHistoryDryRun: historyDryRun,
      resetScopeArchiveRows: resetPreview.wouldBackupAndDelete.filter((row) => row.table.includes("order_history_reason")),
    },
    oldErpRowsInSupabaseResetPreview: resetPreview.wouldBackupAndDelete,
  };

  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-master-reconciliation-${timestampSlug()}.json`);
  const resolvedPath = writeJsonFile(reportPath, report);

  console.log("\n=== OLD_ERP Master Reconciliation Dry Run ===\n");
  console.log("Readiness:", readiness);
  console.log("Source counts:", sourceCounts);
  console.log("Planned target counts:", plannedTargetCounts);
  console.log(`Report: ${resolvedPath}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
