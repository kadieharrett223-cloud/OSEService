#!/usr/bin/env node

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const report = JSON.parse(fs.readFileSync("tmp/import-reports/unresolved-sku-decisions.json", "utf8"));
const rows = [];

for (const decision of report.decisions) {
  for (const invoice of decision.exactInvoices ?? []) {
    rows.push({
      source_sku: decision.sourceSku,
      source_description: null,
      customer_name: invoice.customer ?? null,
      invoice_number: invoice.invoice ?? null,
      quantity: invoice.qty ?? decision.openUnits,
      source_system: "OLD_ERP_COSMOS",
      source_record_id: `${decision.sourceSku}:${invoice.invoice ?? "NO-INVOICE"}`,
      status: "OPEN",
    });
  }
}

for (const row of [
  { source_sku: "000185", source_description: "4032S / Triple Stacker-S QBO line", invoice_number: "126037", quantity: 1 },
  { source_sku: "10000006", source_description: "HDMBL-10 / The Skipper QBO line", invoice_number: "126037", quantity: 1 },
  { source_sku: "HPU1103", source_description: "HPU2203 / 220v 3 hp power unit QBO line", invoice_number: "126037", quantity: 3 },
  { source_sku: "2PCFHD-12", source_description: "2PCFHD-12 QBO line without resolved shipping mapping", invoice_number: "126037", quantity: 1 },
]) {
  rows.push({
    ...row,
    customer_name: "Larry Shirk",
    source_system: "QBO_INVOICE",
    source_record_id: `126037:${row.source_sku}`,
    status: "OPEN",
  });
}

const uniqueRows = [...new Map(rows.map(row => [`${row.source_system}:${row.source_record_id}`, row])).values()];
console.log(JSON.stringify({ heldRows: uniqueRows.length, heldSkus: [...new Set(uniqueRows.map(row => row.source_sku))], apply: APPLY }, null, 2));

if (!APPLY) {
  console.log("Preview only. Link Supabase and re-run with --apply to seed only held mapping exceptions.");
  process.exit(0);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase environment variables.");
const supabase = createClient(url, key, { auth: { persistSession: false } });
const { error } = await supabase.from("manual_product_mapping_queue").upsert(uniqueRows, { onConflict: "source_system,source_record_id" });
if (error) throw new Error(error.message);
console.log(`Seeded ${uniqueRows.length} held mapping exceptions. No order, inventory, container, or fulfillment rows were changed.`);
