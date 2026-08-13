#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    input: "",
    csvOut: "tmp/azure-previous-sku-mapping.csv",
    apply: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") {
      args.input = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }

    if (token === "--csv-out") {
      args.csvOut = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }

    if (token === "--apply") {
      args.apply = true;
      continue;
    }
  }

  return args;
}

function normalizeSku(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeSkuKey(value) {
  const sku = normalizeSku(value);
  if (!sku) return null;
  const compact = sku.replace(/[^A-Z0-9]/g, "");
  return compact || null;
}

function readJsonRows(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    fail(`Input file not found: ${resolved}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    fail(`Could not parse JSON input: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.records)) return parsed.records;
  if (Array.isArray(parsed?.items)) return parsed.items;

  fail("Input JSON must be an array or contain records/items array.");
}

function toCsvCell(value) {
  const text = String(value ?? "");
  if (!text.includes(",") && !text.includes("\"") && !text.includes("\n") && !text.includes("\r")) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function buildMappings(rows) {
  const mappingByAlias = new Map();
  let withMatched = 0;

  for (const row of rows) {
    const alias = normalizeSku(row?.itemCode ?? row?.item_code ?? row?.sku ?? row?.partNumber);
    const canonical = normalizeSku(row?.matchedItemCode ?? row?.matched_item_code ?? row?.matchedSku);
    if (!canonical) continue;

    withMatched += 1;
    if (!alias || alias === canonical) continue;

    const existing = mappingByAlias.get(alias) ?? {
      alias,
      canonicalCounts: new Map(),
      sampleIds: new Set(),
    };

    existing.canonicalCounts.set(canonical, (existing.canonicalCounts.get(canonical) ?? 0) + 1);

    const sourceId = String(row?.id ?? row?.lineId ?? row?.queueLineId ?? "").trim();
    if (sourceId) existing.sampleIds.add(sourceId);

    mappingByAlias.set(alias, existing);
  }

  const resolved = [];
  const conflicts = [];

  for (const entry of mappingByAlias.values()) {
    const canonicalChoices = Array.from(entry.canonicalCounts.entries())
      .sort((a, b) => b[1] - a[1]);

    if (canonicalChoices.length === 0) continue;

    if (canonicalChoices.length > 1) {
      conflicts.push({
        alias: entry.alias,
        choices: canonicalChoices.map(([canonical, count]) => ({ canonical, count })),
      });
      continue;
    }

    const [[canonical, count]] = canonicalChoices;
    resolved.push({
      alias: entry.alias,
      canonical,
      count,
      notes: `source=azure-matchedItemCode; matched_count=${count}`,
    });
  }

  resolved.sort((a, b) => a.alias.localeCompare(b.alias));
  conflicts.sort((a, b) => a.alias.localeCompare(b.alias));

  return {
    withMatched,
    resolved,
    conflicts,
  };
}

function writeCsv(csvPath, rows) {
  const resolved = path.resolve(csvPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const lines = [
    "sku,canonical_product_sku,notes",
    ...rows.map((row) => [
      toCsvCell(row.alias),
      toCsvCell(row.canonical),
      toCsvCell(row.notes),
    ].join(",")),
  ];

  fs.writeFileSync(resolved, `${lines.join("\n")}\n`, "utf8");
  return resolved;
}

async function loadProducts(supabase) {
  const { data, error } = await supabase.from("products").select("id, sku");
  if (error) {
    fail(`Could not load products: ${error.message}`);
  }

  const bySku = new Map();
  const bySkuKey = new Map();

  for (const row of data ?? []) {
    const sku = normalizeSku(row.sku);
    if (!sku) continue;

    bySku.set(sku, row.id);
    const skuKey = normalizeSkuKey(sku);
    if (skuKey) bySkuKey.set(skuKey, row.id);
  }

  return { bySku, bySkuKey };
}

function resolveProductId(products, canonicalSku) {
  const direct = products.bySku.get(canonicalSku);
  if (direct) return direct;

  const skuKey = normalizeSkuKey(canonicalSku);
  if (!skuKey) return null;

  return products.bySkuKey.get(skuKey) ?? null;
}

async function applyAliases(rows) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    fail("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const products = await loadProducts(supabase);
  const unresolved = [];
  const upserts = [];

  for (const row of rows) {
    const productId = resolveProductId(products, row.canonical);
    if (!productId) {
      unresolved.push(row);
      continue;
    }

    upserts.push({
      product_id: productId,
      alias: row.alias,
      source_type: "import",
      source_ref: "OLD_ERP_BACKLOG_MATCHED_MAPPING",
    });
  }

  console.log("Apply summary:", {
    prepared: rows.length,
    unresolvedCanonicalProducts: unresolved.length,
    aliasUpsertsPrepared: upserts.length,
  });

  if (unresolved.length > 0) {
    console.log("Unresolved canonical SKUs:", unresolved.map((row) => row.canonical));
  }

  if (upserts.length === 0) {
    fail("No alias upserts prepared after canonical product resolution.");
  }

  const { data: existingAliases, error: existingError } = await supabase
    .from("product_aliases")
    .select("product_id, alias, source_type")
    .eq("source_type", "import");

  if (existingError) {
    fail(`Could not read existing aliases before insert: ${existingError.message}`);
  }

  const existingKeys = new Set((existingAliases ?? []).map((row) => `${row.product_id}|${String(row.alias ?? "").trim().toUpperCase()}|${row.source_type}`));
  const inserts = upserts.filter((row) => !existingKeys.has(`${row.product_id}|${row.alias}|${row.source_type}`));

  if (inserts.length === 0) {
    console.log("No new aliases required; existing mappings were left unchanged.");
    return;
  }

  const { error } = await supabase.from("product_aliases").insert(inserts);

  if (error) {
    fail(`Alias upsert failed: ${error.message}`);
  }

  console.log(`Applied ${inserts.length} new product_aliases rows; existing mappings left unchanged.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    fail("Usage: node scripts/import-old-erp-sku-mapping-from-backlog.mjs --input <path-to-backlog-json> [--csv-out <path>] [--apply]");
  }

  const rows = readJsonRows(args.input);
  const mappings = buildMappings(rows);
  const csvPath = writeCsv(args.csvOut, mappings.resolved);

  console.log("Preview summary:", {
    sourceRows: rows.length,
    sourceRowsWithMatchedItemCode: mappings.withMatched,
    resolvedAliasMappings: mappings.resolved.length,
    conflictsSkipped: mappings.conflicts.length,
    csvOut: csvPath,
  });

  if (mappings.conflicts.length > 0) {
    console.log("Conflicts skipped:", mappings.conflicts);
  }

  if (!args.apply) {
    console.log("Preview only. Re-run with --apply to write product_aliases.");
    return;
  }

  await applyAliases(mappings.resolved);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
