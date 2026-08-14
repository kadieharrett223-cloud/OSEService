#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  loadCosmosSources,
  normalizeSku,
  normalizeText,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

const SOURCE_TYPE = "RECOUNT";
const CORRECTION_PREFIX = "OLD_ERP_OPENING_CORRECTION";

function parseArgs(argv) {
  const args = { exportsDir: "tmp/exports", apply: false, reportOut: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--exports-dir") {
      args.exportsDir = String(argv[index + 1] ?? "").trim() || args.exportsDir;
      index += 1;
    }
    if (token === "--apply") args.apply = true;
    if (token === "--report-out") {
      args.reportOut = String(argv[index + 1] ?? "").trim();
      index += 1;
    }
  }
  return args;
}

async function loadAll(supabase, table, select) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
    if (error) fail(`Could not read ${table}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

function numberValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function buildProductMap(products, aliases) {
  const map = new Map();
  for (const product of products) {
    const sku = normalizeSku(product.sku);
    if (sku) map.set(sku, product.id);
  }
  for (const alias of aliases) {
    const aliasSku = normalizeSku(alias.alias);
    if (aliasSku && alias.product_id) map.set(aliasSku, alias.product_id);
  }
  return map;
}

function buildCurrentFloorMap(transactions) {
  const map = new Map();
  for (const transaction of transactions) {
    if (!transaction.product_id || transaction.bucket !== "ON_FLOOR") continue;
    const current = numberValue(map.get(transaction.product_id));
    map.set(transaction.product_id, current + numberValue(transaction.delta));
  }
  return map;
}

function buildPlan(sourceProducts, productMap, currentFloorByProduct) {
  const rows = [];
  const unmapped = [];
  const duplicateSourceIds = new Set();
  const seenSourceIds = new Set();

  const latestByOperationalSku = new Map();
  for (const sourceProduct of sourceProducts) {
    const sourceSku = normalizeSku(sourceProduct.itemCode) ?? normalizeSku(sourceProduct.sku);
    if (!sourceSku) continue;
    const existing = latestByOperationalSku.get(sourceSku);
    const existingDate = existing?.updatedAt ? Date.parse(existing.updatedAt) : 0;
    const nextDate = sourceProduct.updatedAt ? Date.parse(sourceProduct.updatedAt) : 0;
    if (!existing || nextDate >= existingDate) latestByOperationalSku.set(sourceSku, sourceProduct);
  }

  const sourceRowsByProduct = new Map();

  for (const sourceProduct of latestByOperationalSku.values()) {
    const sourceRecordId = normalizeText(sourceProduct.id);
    const sourceSku = normalizeSku(sourceProduct.itemCode) ?? normalizeSku(sourceProduct.sku);
    if (!sourceRecordId || !sourceSku) continue;
    if (seenSourceIds.has(sourceRecordId)) {
      duplicateSourceIds.add(sourceRecordId);
      continue;
    }
    seenSourceIds.add(sourceRecordId);

    const productId = productMap.get(sourceSku) ?? productMap.get(normalizeSku(sourceProduct.sku));
    if (!productId) {
      unmapped.push({ sourceRecordId, sourceSku, name: normalizeText(sourceProduct.displayName) });
      continue;
    }

    const sourceRows = sourceRowsByProduct.get(productId) ?? [];
    sourceRows.push({
      sourceRecordId,
      sourceSku,
      name: normalizeText(sourceProduct.displayName),
      oldOpeningFloor: numberValue(sourceProduct.onFloor ?? sourceProduct.onHand),
    });
    sourceRowsByProduct.set(productId, sourceRows);
  }

  const mappingConflicts = [];
  for (const [productId, sourceRows] of sourceRowsByProduct.entries()) {
    const sourceSkus = Array.from(new Set(sourceRows.map((row) => row.sourceSku)));
    if (sourceSkus.length > 1) {
      mappingConflicts.push({
        productId,
        sourceSkus,
        sourceRows,
      });
      continue;
    }

    const oldOpeningFloor = sourceRows.reduce((sum, row) => sum + row.oldOpeningFloor, 0);
    const currentFloor = numberValue(currentFloorByProduct.get(productId));
    rows.push({
      productId,
      sourceRecordId: sourceRows[0].sourceRecordId,
      sourceSku: sourceRows[0].sourceSku,
      name: sourceRows[0].name,
      oldOpeningFloor,
      currentFloor,
      delta: oldOpeningFloor - currentFloor,
      sourceEventKey: `${CORRECTION_PREFIX}:${productId}`,
    });
  }

  return { rows, unmapped, duplicateSourceIds: Array.from(duplicateSourceIds), mappingConflicts };
}

async function applyPlan(supabase, rows) {
  const changes = rows.filter((row) => row.delta !== 0);
  let inserted = 0;

  for (const row of changes) {
    const { data: existing, error: existingError } = await supabase
      .from("inventory_transactions")
      .select("id")
      .eq("source_type", SOURCE_TYPE)
      .eq("source_event_key", row.sourceEventKey)
      .maybeSingle();

    if (existingError) fail(`Could not check opening baseline ${row.sourceEventKey}: ${existingError.message}`);
    if (existing?.id) continue;

    const { error } = await supabase.from("inventory_transactions").insert({
      product_id: row.productId,
      bucket: "ON_FLOOR",
      delta: row.delta,
      before_qty: row.currentFloor,
      after_qty: row.oldOpeningFloor,
      reason: "OLD_ERP validated opening inventory baseline",
      source_type: SOURCE_TYPE,
      source_event_key: row.sourceEventKey,
    });

    if (error) fail(`Could not write opening baseline for ${row.sourceSku}: ${error.message}`);
    inserted += 1;
  }

  return { baselineRowsInserted: inserted, changedRows: changes.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadCosmosSources({ exportsDir: args.exportsDir });
  const supabase = createSupabaseAdminClient();
  const [products, aliases, transactions] = await Promise.all([
    loadAll(supabase, "products", "id, sku"),
    loadAll(supabase, "product_aliases", "product_id, alias"),
    loadAll(supabase, "inventory_transactions", "product_id, bucket, delta, source_type, source_event_key"),
  ]);

  const plan = buildPlan(
    sources.products,
    buildProductMap(products, aliases),
    buildCurrentFloorMap(transactions),
  );
  const changes = plan.rows.filter((row) => row.delta !== 0);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    sourceFile: sources.files.Products,
    sourceProductCount: sources.products.length,
    targetProductCount: products.length,
    mappedProductCount: plan.rows.length,
    unmappedProductCount: plan.unmapped.length,
    unmappedProducts: plan.unmapped,
    duplicateSourceIds: plan.duplicateSourceIds,
    mappingConflicts: plan.mappingConflicts,
    baselineSummary: {
      productsCompared: plan.rows.length,
      productsAlreadyMatching: plan.rows.length - changes.length,
      productsNeedingBaseline: changes.length,
      totalOldOpeningFloor: plan.rows.reduce((sum, row) => sum + row.oldOpeningFloor, 0),
      totalCurrentFloor: plan.rows.reduce((sum, row) => sum + row.currentFloor, 0),
      totalDeltaToApply: changes.reduce((sum, row) => sum + row.delta, 0),
    },
    sampleChanges: changes.slice(0, 100),
    notes: [
      "This uses Products.onFloor/onHand as a validated opening baseline.",
      "It does not replay InventoryAdjustments transaction-by-transaction.",
      "It writes only RECOUNT baseline rows and is idempotent by source_event_key.",
      "Incoming inventory remains container-driven from active container_lines.",
    ],
  };

  if (args.apply) report.applyResults = await applyPlan(supabase, plan.rows);

  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-opening-inventory-${timestampSlug()}.json`);
  const resolved = writeJsonFile(reportPath, report);
  console.log("\n=== OLD_ERP Opening Inventory Sync ===\n");
  console.log(report.baselineSummary);
  console.log(`Unmapped products: ${report.unmappedProductCount}`);
  if (report.applyResults) console.log("Apply results:", report.applyResults);
  console.log(`Report: ${resolved}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown opening inventory sync failure"));
