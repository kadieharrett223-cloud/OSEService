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
  toBool,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

const SOURCE_SYSTEM = "OLD_ERP";
const PRODUCT_SOURCE_REF = "OLD_ERP_PRODUCTS_EXPORT";

function parseArgs(argv) {
  const args = {
    exportsDir: "tmp/exports",
    productsFile: "",
    apply: false,
    reportOut: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--exports-dir") {
      args.exportsDir = String(argv[i + 1] ?? "").trim() || args.exportsDir;
      i += 1;
      continue;
    }
    if (token === "--products-file") {
      args.productsFile = String(argv[i + 1] ?? "").trim();
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

function collectAliases(sourceProduct) {
  const aliases = new Set();

  const itemCode = normalizeSku(sourceProduct?.itemCode);
  if (itemCode) aliases.add(itemCode);

  const sourceAliases = Array.isArray(sourceProduct?.aliases) ? sourceProduct.aliases : [];
  for (const alias of sourceAliases) {
    const normalized = normalizeSku(alias);
    if (normalized) aliases.add(normalized);
  }

  const qbMatchText = normalizeSku(sourceProduct?.qbMatchText);
  if (qbMatchText) aliases.add(qbMatchText);

  const sourceSku = normalizeSku(sourceProduct?.sku);
  if (sourceSku) aliases.delete(sourceSku);

  return Array.from(aliases);
}

function normalizeSourceProducts(products) {
  const bySku = new Map();

  for (const raw of products) {
    const sku = normalizeSku(raw?.sku);
    const sourceRecordId = normalizeText(raw?.id);

    if (!sku || !sourceRecordId) {
      continue;
    }

    const statusRaw = String(raw?.status ?? "Active").trim().toLowerCase();
    const inactiveFlag = toBool(raw?.inactive);
    const status = inactiveFlag || statusRaw === "inactive" || statusRaw === "discontinued"
      ? "Inactive"
      : "Active";

    const next = {
      sku,
      sourceRecordId,
      sourceKey: `OLD_ERP_PRODUCT:${sourceRecordId}`,
      canonicalName: normalizeText(raw?.displayName) ?? normalizeText(raw?.description) ?? sku,
      description: normalizeText(raw?.description),
      status,
      aliases: collectAliases(raw),
    };

    const existing = bySku.get(sku);
    if (!existing) {
      bySku.set(sku, next);
      continue;
    }

    const mergedAliases = new Set([...(existing.aliases ?? []), ...(next.aliases ?? [])]);
    bySku.set(sku, {
      ...existing,
      aliases: Array.from(mergedAliases),
      canonicalName: existing.canonicalName ?? next.canonicalName,
      description: existing.description ?? next.description,
    });
  }

  return Array.from(bySku.values());
}

async function loadExistingProductsAndAliases(supabase) {
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id, sku, source_system, source_record_id, source_key");

  if (productsError) {
    fail(`Could not read products: ${productsError.message}`);
  }

  const { data: aliases, error: aliasError } = await supabase
    .from("product_aliases")
    .select("id, product_id, alias, source_type, source_ref");

  if (aliasError) {
    fail(`Could not read product_aliases: ${aliasError.message}`);
  }

  const productsBySku = new Map();
  for (const product of products ?? []) {
    const sku = normalizeSku(product.sku);
    if (!sku) continue;
    productsBySku.set(sku, product);
  }

  return {
    products: products ?? [],
    aliases: aliases ?? [],
    productsBySku,
  };
}

function buildPreview(normalizedSourceProducts, existing) {
  const preview = {
    sourceProducts: normalizedSourceProducts.length,
    existingProducts: existing.products.length,
    newProductsToInsert: 0,
    existingProductsMatchedBySku: 0,
    existingWithOldErpSourceTag: 0,
    existingWithoutOldErpTag: 0,
    aliasesPlanned: 0,
    aliasesAlreadyPresent: 0,
    aliasConflicts: 0,
    sampleNewSkus: [],
    sampleUntaggedExistingSkus: [],
  };

  const aliasExistingSet = new Set(
    existing.aliases.map((row) => `${row.product_id}|${normalizeSku(row.alias)}|${row.source_type ?? "import"}`),
  );

  const productPlans = [];
  const aliasPlans = [];

  for (const sourceProduct of normalizedSourceProducts) {
    const existingProduct = existing.productsBySku.get(sourceProduct.sku) ?? null;

    if (!existingProduct) {
      preview.newProductsToInsert += 1;
      if (preview.sampleNewSkus.length < 25) {
        preview.sampleNewSkus.push(sourceProduct.sku);
      }
      productPlans.push({
        action: "insert",
        sku: sourceProduct.sku,
        sourceRecordId: sourceProduct.sourceRecordId,
        sourceKey: sourceProduct.sourceKey,
        canonicalName: sourceProduct.canonicalName,
        description: sourceProduct.description,
        status: sourceProduct.status,
      });
    } else {
      preview.existingProductsMatchedBySku += 1;
      if (String(existingProduct.source_system ?? "").trim().toUpperCase() === SOURCE_SYSTEM) {
        preview.existingWithOldErpSourceTag += 1;
      } else {
        preview.existingWithoutOldErpTag += 1;
        if (preview.sampleUntaggedExistingSkus.length < 25) {
          preview.sampleUntaggedExistingSkus.push(sourceProduct.sku);
        }
      }
      productPlans.push({
        action: "existing",
        productId: existingProduct.id,
        sku: sourceProduct.sku,
      });
    }

    const targetProductId = existingProduct?.id ?? null;
    for (const alias of sourceProduct.aliases) {
      if (!alias || alias === sourceProduct.sku) continue;
      aliasPlans.push({
        alias,
        sku: sourceProduct.sku,
        targetProductId,
      });
    }
  }

  const dedupAliasPlans = [];
  const aliasSeen = new Set();
  for (const row of aliasPlans) {
    const key = `${row.sku}|${row.alias}`;
    if (aliasSeen.has(key)) continue;
    aliasSeen.add(key);
    dedupAliasPlans.push(row);
  }

  for (const row of dedupAliasPlans) {
    if (!row.targetProductId) {
      continue;
    }
    const existingKey = `${row.targetProductId}|${row.alias}|import`;
    if (aliasExistingSet.has(existingKey)) {
      preview.aliasesAlreadyPresent += 1;
      continue;
    }
    preview.aliasesPlanned += 1;
  }

  return {
    preview,
    productPlans,
    aliasPlans: dedupAliasPlans,
  };
}

async function applyChanges(supabase, sourceProducts, plan) {
  const insertRows = plan.productPlans
    .filter((row) => row.action === "insert")
    .map((row) => ({
      sku: row.sku,
      canonical_name: row.canonicalName,
      description: row.description,
      status: row.status,
      source_system: SOURCE_SYSTEM,
      source_record_id: row.sourceRecordId,
      source_key: row.sourceKey,
    }));

  if (insertRows.length > 0) {
    const { error } = await supabase.from("products").insert(insertRows);
    if (error) {
      fail(`Could not insert OLD_ERP products: ${error.message}`);
    }
  }

  const { productsBySku } = await loadExistingProductsAndAliases(supabase);

  const aliasUpserts = [];
  for (const sourceProduct of sourceProducts) {
    const target = productsBySku.get(sourceProduct.sku);
    if (!target?.id) continue;

    for (const alias of sourceProduct.aliases) {
      if (!alias || alias === sourceProduct.sku) continue;
      aliasUpserts.push({
        product_id: target.id,
        alias,
        source_type: "import",
        source_ref: PRODUCT_SOURCE_REF,
      });
    }
  }

  const uniqueAliasRows = [];
  const seen = new Set();
  for (const row of aliasUpserts) {
    const key = `${row.product_id}|${row.alias}|${row.source_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueAliasRows.push(row);
  }

  if (uniqueAliasRows.length > 0) {
    const { error } = await supabase
      .from("product_aliases")
      .upsert(uniqueAliasRows, { onConflict: "product_id,alias,source_type" });

    if (error) {
      fail(`Could not upsert OLD_ERP product aliases: ${error.message}`);
    }
  }

  return {
    productsInserted: insertRows.length,
    aliasesUpserted: uniqueAliasRows.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadCosmosSources({
    exportsDir: args.exportsDir,
    explicitFiles: {
      Products: args.productsFile,
    },
  });

  const sourceProducts = normalizeSourceProducts(sources.products);
  const supabase = createSupabaseAdminClient();
  const existing = await loadExistingProductsAndAliases(supabase);
  const plan = buildPreview(sourceProducts, existing);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    sourceFile: sources.files.Products,
    preview: plan.preview,
    sampleProductPlans: plan.productPlans.slice(0, 100),
    sampleAliasPlans: plan.aliasPlans.slice(0, 100),
    warnings: [
      "Existing products matched by SKU are not retro-labeled as OLD_ERP unless inserted by this script.",
      "Aliases are upserted with source_ref=OLD_ERP_PRODUCTS_EXPORT.",
    ],
  };

  if (args.apply) {
    report.applyResults = await applyChanges(supabase, sourceProducts, plan);
  }

  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-products-aliases-${timestampSlug()}.json`);
  const resolvedReportPath = writeJsonFile(reportPath, report);

  console.log("\n=== OLD_ERP Products/Aliases Migration ===\n");
  console.log(report.preview);
  if (report.applyResults) {
    console.log("Apply results:", report.applyResults);
  }
  console.log(`Report: ${resolvedReportPath}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
