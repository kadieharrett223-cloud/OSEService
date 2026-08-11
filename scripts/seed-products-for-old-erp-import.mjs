#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

const CANONICAL_OVERRIDES = {
  "HK-4PCA": "4PCA",
};

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    input: "",
    apply: false,
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
    }
  }

  return args;
}

function normalizeSku(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeSkuKey(value) {
  return normalizeSku(value).replace(/[^A-Z0-9]/g, "");
}

function normalizeText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function readWorklist(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    fail(`Worklist not found: ${resolved}`);
  }

  const lines = fs.readFileSync(resolved, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    fail("Worklist CSV must include a header and at least one data row.");
  }

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const sku = normalizeSku(cells[0]);
    const description = normalizeText(cells[4]);
    const canonicalFromFile = normalizeSku(cells[5]);
    const canonicalSku = canonicalFromFile || CANONICAL_OVERRIDES[sku] || sku;

    return {
      sku,
      description,
      canonicalSku,
    };
  }).filter((row) => row.sku.length > 0);
}

async function loadQboIndex(supabase) {
  const byItemName = new Map();
  let from = 0;
  const pageSize = 500;

  while (true) {
    const { data, error } = await supabase
      .from("quickbooks_invoices")
      .select("raw_payload")
      .range(from, from + pageSize - 1);

    if (error) {
      fail(`Could not read quickbooks_invoices: ${error.message}`);
    }

    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const row of rows) {
      const lines = Array.isArray(row.raw_payload?.Line) ? row.raw_payload.Line : [];
      for (const line of lines) {
        const itemName = normalizeSku(line?.SalesItemLineDetail?.ItemRef?.name);
        const description = normalizeText(line?.Description);
        if (!itemName) continue;

        const key = normalizeSkuKey(itemName);
        if (!byItemName.has(key)) {
          byItemName.set(key, {
            itemName,
            description,
          });
        }
      }
    }

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return byItemName;
}

function getQboSuggestion(qboIndex, sku) {
  const direct = qboIndex.get(normalizeSkuKey(sku));
  if (direct) return direct;

  if (sku.startsWith("HK-")) {
    const stripped = qboIndex.get(normalizeSkuKey(sku.slice(3)));
    if (stripped) return stripped;
  }

  return null;
}

async function loadExistingProducts(supabase) {
  const { data, error } = await supabase.from("products").select("id, sku");
  if (error) {
    fail(`Could not read products: ${error.message}`);
  }

  const bySku = new Map();
  for (const row of data ?? []) {
    bySku.set(normalizeSku(row.sku), row.id);
  }

  return bySku;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    fail("Usage: node scripts/seed-products-for-old-erp-import.mjs --input <csv-path> [--apply]");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    fail("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const worklist = readWorklist(args.input);
  const qboIndex = await loadQboIndex(supabase);
  const existingProducts = await loadExistingProducts(supabase);

  const productRows = [];
  const aliasRows = [];
  const canonicalSeen = new Set();

  for (const row of worklist) {
    const qboSuggestion = getQboSuggestion(qboIndex, row.sku) ?? getQboSuggestion(qboIndex, row.canonicalSku);
    const canonicalSku = row.canonicalSku;

    if (!canonicalSeen.has(canonicalSku)) {
      canonicalSeen.add(canonicalSku);

      const canonicalName = normalizeText(qboSuggestion?.description)
        || row.description
        || canonicalSku;

      productRows.push({
        sku: canonicalSku,
        canonical_name: canonicalName,
        description: normalizeText(qboSuggestion?.description) || row.description,
        status: "Active",
      });
    }

    if (row.sku !== canonicalSku) {
      aliasRows.push({
        alias: row.sku,
        canonicalSku,
      });
    }

    if (qboSuggestion?.itemName && qboSuggestion.itemName !== canonicalSku) {
      aliasRows.push({
        alias: qboSuggestion.itemName,
        canonicalSku,
      });
    }
  }

  const existingProductCount = existingProducts.size;
  const summary = {
    worklistRows: worklist.length,
    canonicalProductsPlanned: productRows.length,
    aliasesPlanned: aliasRows.length,
    existingProducts: existingProductCount,
  };

  console.log("Summary:", summary);

  if (!args.apply) {
    console.log("Preview only. Re-run with --apply to seed products and aliases.");
    return;
  }

  if (existingProductCount > 0) {
    fail(`Expected an empty products table for explicit seed, found ${existingProductCount} existing product(s). Stop and review before writing.`);
  }

  const { error: productError } = await supabase
    .from("products")
    .upsert(productRows, { onConflict: "sku" });

  if (productError) {
    fail(`Product upsert failed: ${productError.message}`);
  }

  const productIds = await loadExistingProducts(supabase);
  const aliasUpserts = aliasRows
    .map((row) => ({
      product_id: productIds.get(row.canonicalSku),
      alias: row.alias,
      source_type: "import",
      source_ref: "OLD_ERP_PRODUCT_SEED",
    }))
    .filter((row) => Boolean(row.product_id));

  if (aliasUpserts.length > 0) {
    const { error: aliasError } = await supabase
      .from("product_aliases")
      .upsert(aliasUpserts, { onConflict: "product_id,alias,source_type" });

    if (aliasError) {
      fail(`Alias upsert failed: ${aliasError.message}`);
    }
  }

  console.log(`Applied ${productRows.length} products and ${aliasUpserts.length} aliases.`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});