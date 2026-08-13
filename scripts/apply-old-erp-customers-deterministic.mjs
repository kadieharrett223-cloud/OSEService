#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { buildCustomerResolutionPreview } from "./preview-old-erp-customer-resolution.mjs";
import {
  createSupabaseAdminClient,
  fail,
  loadCosmosSources,
  normalizeEmail,
  normalizePhone,
  normalizeText,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

function parseArgs(argv) {
  const args = {
    exportsDir: "tmp/exports",
    apply: false,
    reportOut: "",
    productsFile: "",
    warehouseInvoicesFile: "",
    inventoryAdjustmentsFile: "",
    containerDraftsFile: "",
    invoiceQueueItemsFile: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--exports-dir") {
      args.exportsDir = String(argv[i + 1] ?? "").trim() || args.exportsDir;
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
  }

  return args;
}

function mapCreateRows(preview) {
  const rows = [];

  for (const entry of preview.resolutionRows) {
    if (entry?.resolution?.status !== "CREATE_NEW") continue;

    const fullName = normalizeText(entry.customerName);
    if (!fullName) continue;

    rows.push({
      full_name: fullName,
      company_name: fullName,
      email: normalizeEmail(entry.email),
      phone: normalizePhone(entry.phone),
      shipping_address: normalizeText(entry.address),
      quickbooks_customer_id: normalizeText(entry.quickbooksCustomerId),
    });
  }

  return rows;
}

function dedupeRows(rows) {
  const byKey = new Map();

  for (const row of rows) {
    const key = [
      row.quickbooks_customer_id ?? "",
      row.email ?? "",
      row.phone ?? "",
      row.full_name ?? "",
      row.shipping_address ?? "",
    ].join("|");

    if (!byKey.has(key)) {
      byKey.set(key, row);
    }
  }

  return Array.from(byKey.values());
}

async function upsertCustomers(supabase, rows) {
  if (rows.length === 0) {
    return {
      inserted: 0,
      skippedExisting: 0,
    };
  }

  let inserted = 0;
  let skippedExisting = 0;

  for (const row of rows) {
    let exists = false;

    if (row.quickbooks_customer_id) {
      const { data } = await supabase
        .from("customers")
        .select("id")
        .eq("quickbooks_customer_id", row.quickbooks_customer_id)
        .limit(1)
        .maybeSingle();
      if (data?.id) exists = true;
    }

    if (!exists && row.email) {
      const { data } = await supabase
        .from("customers")
        .select("id")
        .ilike("email", row.email)
        .limit(1)
        .maybeSingle();
      if (data?.id) exists = true;
    }

    if (!exists && row.phone) {
      const { data } = await supabase
        .from("customers")
        .select("id")
        .ilike("phone", row.phone)
        .limit(1)
        .maybeSingle();
      if (data?.id) exists = true;
    }

    if (!exists) {
      const { data } = await supabase
        .from("customers")
        .select("id")
        .ilike("full_name", row.full_name)
        .limit(1)
        .maybeSingle();
      if (data?.id) exists = true;
    }

    if (exists) {
      skippedExisting += 1;
      continue;
    }

    const { error } = await supabase.from("customers").insert(row);
    if (error) {
      fail(`Could not insert customer ${row.full_name}: ${error.message}`);
    }

    inserted += 1;
  }

  return {
    inserted,
    skippedExisting,
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

  const preview = await buildCustomerResolutionPreview(sources);
  const createRows = dedupeRows(mapCreateRows(preview));

  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    sourceFiles: sources.files,
    previewSummary: preview.summary,
    createNewCustomersPlanned: createRows.length,
    createRowsSample: createRows.slice(0, 50),
    notes: [
      "Only deterministic CREATE_NEW customer groups are inserted.",
      "AMBIGUOUS groups remain untouched and must be resolved manually.",
    ],
  };

  if (args.apply) {
    const supabase = createSupabaseAdminClient();
    report.applyResults = await upsertCustomers(supabase, createRows);
  }

  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-customers-deterministic-${timestampSlug()}.json`);
  const resolvedPath = writeJsonFile(reportPath, report);

  console.log("\n=== OLD_ERP Deterministic Customer Migration ===\n");
  console.log({
    createNewCustomersPlanned: report.createNewCustomersPlanned,
    previewSummary: report.previewSummary,
    applyResults: report.applyResults ?? null,
  });
  console.log(`Report: ${resolvedPath}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
