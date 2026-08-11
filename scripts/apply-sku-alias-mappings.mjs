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
      continue;
    }
  }

  return args;
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

function readCsv(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    fail(`CSV file not found: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, "utf8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    fail("CSV file must include a header row and at least one data row.");
  }

  const header = parseCsvLine(lines[0]).map((cell) => cell.trim());
  const index = {
    sku: header.indexOf("sku"),
    canonicalSku: header.indexOf("canonical_product_sku"),
    notes: header.indexOf("notes"),
  };

  if (index.sku < 0 || index.canonicalSku < 0) {
    fail("CSV must contain sku and canonical_product_sku columns.");
  }

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    const sku = String(values[index.sku] ?? "").trim().toUpperCase();
    const canonicalSku = String(values[index.canonicalSku] ?? "").trim().toUpperCase();
    const notes = index.notes >= 0 ? String(values[index.notes] ?? "").trim() : "";

    if (!sku) continue;

    rows.push({ sku, canonicalSku, notes, rowNumber: i + 1 });
  }

  return rows;
}

function normalizeSkuKey(value) {
  const sku = String(value ?? "").trim().toUpperCase();
  if (!sku) return null;
  const compact = sku.replace(/[^A-Z0-9]/g, "");
  return compact || null;
}

async function loadProducts(supabase) {
  const { data, error } = await supabase.from("products").select("id, sku");
  if (error) {
    fail(`Could not load products: ${error.message}`);
  }

  const bySku = new Map();
  const bySkuKey = new Map();

  for (const row of data ?? []) {
    const sku = String(row.sku ?? "").trim().toUpperCase();
    if (!sku) continue;

    bySku.set(sku, row.id);
    const skuKey = normalizeSkuKey(sku);
    if (skuKey) bySkuKey.set(skuKey, row.id);
  }

  return { bySku, bySkuKey };
}

function resolveCanonicalProductId(mapping, row) {
  if (!row.canonicalSku) return null;

  const direct = mapping.bySku.get(row.canonicalSku);
  if (direct) return direct;

  const key = normalizeSkuKey(row.canonicalSku);
  if (!key) return null;

  return mapping.bySkuKey.get(key) ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    fail("Usage: node scripts/apply-sku-alias-mappings.mjs --input <csv-path> [--apply]");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    fail("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const rows = readCsv(args.input);
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const productMap = await loadProducts(supabase);

  let withCanonical = 0;
  let missingCanonical = 0;
  let unresolvedCanonicalProduct = 0;
  const upserts = [];

  for (const row of rows) {
    if (!row.canonicalSku) {
      missingCanonical += 1;
      continue;
    }

    withCanonical += 1;
    const productId = resolveCanonicalProductId(productMap, row);
    if (!productId) {
      unresolvedCanonicalProduct += 1;
      continue;
    }

    upserts.push({
      product_id: productId,
      alias: row.sku,
      source_type: "import",
      source_ref: "OLD_ERP_CONTAINER_IMPORT",
    });
  }

  const summary = {
    csvRows: rows.length,
    withCanonical,
    missingCanonical,
    unresolvedCanonicalProduct,
    aliasUpsertsPrepared: upserts.length,
  };

  console.log("Summary:", summary);

  if (!args.apply) {
    console.log("Preview only. Re-run with --apply to write aliases.");
    return;
  }

  if (upserts.length === 0) {
    fail("No alias upserts prepared. Fill canonical_product_sku mappings first.");
  }

  const { error } = await supabase.from("product_aliases").upsert(upserts, {
    onConflict: "product_id,alias,source_type",
  });

  if (error) {
    fail(`Alias upsert failed: ${error.message}`);
  }

  console.log(`Applied ${upserts.length} product_aliases upserts.`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
