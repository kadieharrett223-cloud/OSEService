#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  createSupabaseAdminClient,
  fail,
  loadCosmosSources,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeText,
  pickFirst,
  timestampSlug,
  writeJsonFile,
} from "./old-erp-migration-utils.mjs";

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

function isAcceptedSourceRecord(record) {
  const approval = String(record?.approvalStatus ?? "").trim().toUpperCase();
  const queue = String(record?.queueStatus ?? record?.status ?? "").trim().toUpperCase();
  const warehouse = String(record?.warehouseStatus ?? "").trim().toUpperCase();
  const accepted = approval === "APPROVED" || queue === "APPROVED" || Boolean(record?.approvedAt);
  const deniedBeforeAcceptance = approval === "DENIED" && !record?.approvedAt;
  const removedBeforeAcceptance = Boolean(record?.removed) && approval !== "APPROVED" && queue !== "APPROVED" && !record?.approvedAt;
  const terminalWithoutAcceptance = ["DENIED", "REMOVED", "CANCELLED"].includes(queue) && !accepted;
  const knownAcceptedState = ["APPROVED", "IN_WAREHOUSE", "PICKED", "READY_TO_SHIP", "PARTIALLY_FULFILLED", "FULFILLED", "SHIPPED", "COMPLETED"].includes(warehouse);

  return !deniedBeforeAcceptance && !removedBeforeAcceptance && !terminalWithoutAcceptance && (accepted || knownAcceptedState);
}

function customerEvidence(record) {
  const customerName = normalizeText(record?.customerName);
  if (!customerName) return null;
  return {
    full_name: customerName,
    company_name: customerName,
    email: normalizeEmail(pickFirst(record, ["qboEmail", "email"])),
    phone: normalizePhone(pickFirst(record, ["qboPhone", "phone"])),
    shipping_address: normalizeText(pickFirst(record, ["qboShipAddress", "qboBillAddress", "shippingAddress"])),
    quickbooks_customer_id: normalizeText(pickFirst(record, ["qboCustomerId", "quickbooksCustomerId"])),
  };
}

function groupAcceptedCustomers(records) {
  const groups = new Map();
  const acceptedRows = [];

  for (const record of records) {
    if (!isAcceptedSourceRecord(record)) continue;
    const customer = customerEvidence(record);
    if (!customer) continue;
    const key = [
      customer.quickbooks_customer_id ?? "",
      customer.email ?? "",
      customer.phone ?? "",
      normalizeName(customer.full_name) ?? "",
    ].join("|");
    const group = groups.get(key) ?? {
      key,
      ...customer,
      invoiceNumbers: new Set(),
      sourceRecordIds: new Set(),
      lineCount: 0,
    };
    const invoice = normalizeText(record?.invoiceNumber);
    if (invoice) group.invoiceNumbers.add(invoice);
    const sourceId = normalizeText(record?.id ?? record?._id);
    if (sourceId) group.sourceRecordIds.add(sourceId);
    group.lineCount += 1;
    groups.set(key, group);
    acceptedRows.push({ sourceId, invoice, customerName: customer.full_name });
  }

  return {
    acceptedRows,
    groups: Array.from(groups.values()).map((group) => ({
      ...group,
      invoiceNumbers: Array.from(group.invoiceNumbers),
      sourceRecordIds: Array.from(group.sourceRecordIds),
    })),
  };
}

async function loadCustomers(supabase) {
  const { data, error } = await supabase
    .from("customers")
    .select("id, full_name, company_name, email, phone, shipping_address, quickbooks_customer_id");
  if (error) fail(`Could not read customers: ${error.message}`);
  return data ?? [];
}

function resolveCustomers(groups, existing) {
  const byEmail = new Map();
  const byPhone = new Map();
  const byName = new Map();
  const byQbo = new Map();

  for (const customer of existing) {
    if (customer.email) byEmail.set(normalizeEmail(customer.email), customer);
    if (customer.phone) byPhone.set(normalizePhone(customer.phone), customer);
    if (customer.full_name) byName.set(normalizeName(customer.full_name), customer);
    if (customer.company_name) byName.set(normalizeName(customer.company_name), customer);
    if (customer.quickbooks_customer_id) byQbo.set(String(customer.quickbooks_customer_id), customer);
  }

  return groups.map((group) => {
    const candidates = new Map();
    const add = (customer, method) => {
      if (!customer?.id) return;
      const row = candidates.get(customer.id) ?? { customer, methods: [] };
      row.methods.push(method);
      candidates.set(customer.id, row);
    };
    if (group.quickbooks_customer_id) add(byQbo.get(group.quickbooks_customer_id), "quickbooks_customer_id");
    if (group.email) add(byEmail.get(group.email), "email");
    if (group.phone) add(byPhone.get(group.phone), "phone");
    add(byName.get(normalizeName(group.full_name)), "normalized_name");

    const matches = Array.from(candidates.values());
    return {
      ...group,
      resolution: matches.length === 1
        ? { status: "MATCH_EXISTING", customerId: matches[0].customer.id, methods: matches[0].methods }
        : matches.length === 0
          ? { status: "CREATE_NEW", customerId: null, methods: [] }
          : { status: "AMBIGUOUS", customerId: null, methods: matches.flatMap((match) => match.methods), candidates: matches.map((match) => match.customer.id) },
    };
  });
}

async function applyCustomers(supabase, resolutions) {
  let inserted = 0;
  let matched = 0;
  const ambiguous = [];

  for (const group of resolutions) {
    if (group.resolution.status === "AMBIGUOUS") {
      ambiguous.push(group);
      continue;
    }
    if (group.resolution.status === "MATCH_EXISTING") {
      matched += 1;
      continue;
    }

    const { data: created, error } = await supabase
      .from("customers")
      .insert({
        full_name: group.full_name,
        company_name: group.company_name,
        email: group.email,
        phone: group.phone,
        shipping_address: group.shipping_address,
        quickbooks_customer_id: group.quickbooks_customer_id,
      })
      .select("id")
      .single();
    if (error) fail(`Could not transfer accepted OLD_ERP customer ${group.full_name}: ${error.message}`);
    if (created?.id) inserted += 1;
  }

  return { inserted, matched, ambiguous: ambiguous.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = loadCosmosSources({ exportsDir: args.exportsDir });
  const supabase = createSupabaseAdminClient();
  const existing = await loadCustomers(supabase);
  const grouped = groupAcceptedCustomers(sources.invoiceQueueItems);
  const resolutions = resolveCustomers(grouped.groups, existing);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    sourceFile: sources.files.InvoiceQueueItems,
    acceptedSourceLineCount: grouped.acceptedRows.length,
    acceptedCustomerGroupCount: resolutions.length,
    resolutionCounts: {
      matchExisting: resolutions.filter((row) => row.resolution.status === "MATCH_EXISTING").length,
      createNew: resolutions.filter((row) => row.resolution.status === "CREATE_NEW").length,
      ambiguous: resolutions.filter((row) => row.resolution.status === "AMBIGUOUS").length,
    },
    ambiguousCustomers: resolutions.filter((row) => row.resolution.status === "AMBIGUOUS").slice(0, 500),
    sampleTransferredCustomers: resolutions.slice(0, 100),
    notes: [
      "Only customers attached to accepted/approved or warehouse-state OLD_ERP records are included.",
      "Denied/removed-only customers are excluded from the operational customer transfer.",
      "Ambiguous existing customer matches are never silently merged.",
    ],
  };

  if (args.apply) report.applyResults = await applyCustomers(supabase, resolutions);

  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-accepted-customers-${timestampSlug()}.json`);
  const resolved = writeJsonFile(reportPath, report);
  console.log("\n=== OLD_ERP Accepted Customer Transfer ===\n");
  console.log({ acceptedSourceLineCount: report.acceptedSourceLineCount, acceptedCustomerGroupCount: report.acceptedCustomerGroupCount, resolutionCounts: report.resolutionCounts, applyResults: report.applyResults ?? null });
  console.log(`Report: ${resolved}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "Unknown accepted customer transfer failure"));
