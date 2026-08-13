#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { calculateOpeningStateFromSources } from "./calculate-old-erp-opening-state.mjs";
import {
  createSupabaseAdminClient,
  fail,
  loadCosmosSources,
  normalizeAddress,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeText,
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
  }

  return args;
}

function pushIndex(map, key, value) {
  if (!key) return;
  const existing = map.get(key) ?? [];
  existing.push(value);
  map.set(key, existing);
}

function uniqueIds(rows) {
  return Array.from(new Set((rows ?? []).map((row) => row.id).filter(Boolean)));
}

async function loadCustomers(supabase) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];

  while (true) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, full_name, company_name, phone, email, shipping_address, quickbooks_customer_id")
      .range(from, from + pageSize - 1);

    if (error) {
      fail(`Could not read customers: ${error.message}`);
    }

    const batch = data ?? [];
    if (batch.length === 0) break;
    rows.push(...batch);

    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

function buildCustomerIndexes(customers) {
  const byQuickbooks = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  const byName = new Map();
  const byNameAddress = new Map();

  for (const customer of customers) {
    const normalized = {
      ...customer,
      quickbooks_customer_id: normalizeText(customer.quickbooks_customer_id),
      email: normalizeEmail(customer.email),
      phone: normalizePhone(customer.phone),
      normalizedName: normalizeName(customer.company_name ?? customer.full_name),
      normalizedAddress: normalizeAddress(customer.shipping_address),
    };

    pushIndex(byQuickbooks, normalized.quickbooks_customer_id, normalized);
    pushIndex(byEmail, normalized.email, normalized);
    pushIndex(byPhone, normalized.phone, normalized);
    pushIndex(byName, normalized.normalizedName, normalized);

    const nameAddressKey = normalized.normalizedName && normalized.normalizedAddress
      ? `${normalized.normalizedName}|${normalized.normalizedAddress}`
      : null;
    pushIndex(byNameAddress, nameAddressKey, normalized);
  }

  return {
    byQuickbooks,
    byEmail,
    byPhone,
    byName,
    byNameAddress,
  };
}

function sourceCustomerKey(line) {
  const quickbooksCustomerId = normalizeText(
    line.quickbooksCustomerId
      ?? line.qboCustomerId
      ?? line.qboCustomerRef
      ?? line.qboCustomerRefId,
  );
  const email = normalizeEmail(line.qboEmail);
  const phone = normalizePhone(line.qboPhone);
  const name = normalizeName(line.customerName);
  const address = normalizeAddress(line.qboShipAddress ?? line.qboBillAddress);

  if (quickbooksCustomerId) return `QBO:${quickbooksCustomerId}`;
  if (email) return `EMAIL:${email}`;
  if (phone && name) return `PHONE_NAME:${phone}|${name}`;
  if (name && address) return `NAME_ADDR:${name}|${address}`;
  if (name) return `NAME:${name}`;

  return `UNKNOWN:${line.invoiceNumber ?? "NO_INVOICE"}:${line.queueItemId ?? "NO_LINE_ID"}`;
}

function groupSourceCustomers(activeOrderLines) {
  const groups = new Map();

  for (const line of activeOrderLines) {
    const groupKey = sourceCustomerKey(line);
    const group = groups.get(groupKey) ?? {
      key: groupKey,
      customerName: normalizeText(line.customerName),
      quickbooksCustomerId: normalizeText(line.quickbooksCustomerId),
      email: normalizeEmail(line.qboEmail),
      phone: normalizePhone(line.qboPhone),
      address: normalizeAddress(line.qboShipAddress ?? line.qboBillAddress),
      invoiceNumbers: new Set(),
      lineCount: 0,
      qtyTotal: 0,
      sampleLines: [],
    };

    group.invoiceNumbers.add(line.invoiceNumber ?? "NO_INVOICE");
    group.lineCount += 1;
    group.qtyTotal += Number(line.qty ?? 0);

    if (group.sampleLines.length < 20) {
      group.sampleLines.push({
        invoiceNumber: line.invoiceNumber,
        sku: line.sku,
        qty: line.qty,
        priority: line.priority,
      });
    }

    groups.set(groupKey, group);
  }

  return Array.from(groups.values());
}

function resolveGroup(group, indexes) {
  const candidates = new Map();

  const pushCandidateRows = (rows, reason) => {
    for (const row of rows ?? []) {
      const existing = candidates.get(row.id) ?? {
        customerId: row.id,
        reasons: new Set(),
        companyName: row.company_name,
        fullName: row.full_name,
        email: row.email,
        phone: row.phone,
        quickbooksCustomerId: row.quickbooks_customer_id,
      };
      existing.reasons.add(reason);
      candidates.set(row.id, existing);
    }
  };

  if (group.quickbooksCustomerId) {
    pushCandidateRows(indexes.byQuickbooks.get(group.quickbooksCustomerId), "quickbooks_customer_id");
  }
  if (group.email) {
    pushCandidateRows(indexes.byEmail.get(group.email), "email");
  }
  if (group.phone) {
    pushCandidateRows(indexes.byPhone.get(group.phone), "phone");
  }

  const normalizedName = normalizeName(group.customerName);
  const nameAddressKey = normalizedName && group.address ? `${normalizedName}|${group.address}` : null;
  if (nameAddressKey) {
    pushCandidateRows(indexes.byNameAddress.get(nameAddressKey), "name_address");
  }

  if (normalizedName) {
    pushCandidateRows(indexes.byName.get(normalizedName), "name");
  }

  const candidateList = Array.from(candidates.values()).map((entry) => ({
    ...entry,
    reasons: Array.from(entry.reasons),
  }));

  if (candidateList.length === 0) {
    return {
      status: "CREATE_NEW",
      matchedCustomerId: null,
      candidates: [],
      reason: "no existing customer matched by deterministic identifiers",
    };
  }

  if (candidateList.length === 1) {
    return {
      status: "MATCH_EXISTING",
      matchedCustomerId: candidateList[0].customerId,
      candidates: candidateList,
      reason: `resolved with ${candidateList[0].reasons.join("+")}`,
    };
  }

  return {
    status: "AMBIGUOUS",
    matchedCustomerId: null,
    candidates: candidateList,
    reason: "multiple candidate customers matched; manual review required",
  };
}

function summarizeResolution(groups, resolutionRows) {
  const summary = {
    sourceCustomerGroups: groups.length,
    matchedExisting: 0,
    createNew: 0,
    ambiguous: 0,
    orderLinesWithMissingCustomer: 0,
  };

  for (const row of resolutionRows) {
    if (row.resolution.status === "MATCH_EXISTING") {
      summary.matchedExisting += 1;
      continue;
    }

    if (row.resolution.status === "CREATE_NEW") {
      summary.createNew += 1;
      summary.orderLinesWithMissingCustomer += row.lineCount;
      continue;
    }

    if (row.resolution.status === "AMBIGUOUS") {
      summary.ambiguous += 1;
      summary.orderLinesWithMissingCustomer += row.lineCount;
    }
  }

  return summary;
}

export async function buildCustomerResolutionPreview(sources) {
  const openingState = calculateOpeningStateFromSources(sources);
  const sourceCustomerGroups = groupSourceCustomers(openingState.activeOrderLines);

  const supabase = createSupabaseAdminClient();
  const customers = await loadCustomers(supabase);
  const indexes = buildCustomerIndexes(customers);

  const resolutions = sourceCustomerGroups.map((group) => {
    const resolution = resolveGroup(group, indexes);
    return {
      sourceCustomerKey: group.key,
      customerName: group.customerName,
      quickbooksCustomerId: group.quickbooksCustomerId,
      email: group.email,
      phone: group.phone,
      address: group.address,
      invoiceCount: group.invoiceNumbers.size,
      lineCount: group.lineCount,
      qtyTotal: group.qtyTotal,
      sampleLines: group.sampleLines,
      resolution,
    };
  });

  const unresolved = resolutions.filter((row) => row.resolution.status !== "MATCH_EXISTING");
  const ambiguous = resolutions.filter((row) => row.resolution.status === "AMBIGUOUS");

  return {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    existingCustomerCount: customers.length,
    summary: summarizeResolution(sourceCustomerGroups, resolutions),
    resolutionRows: resolutions,
    unresolvedCustomers: unresolved,
    ambiguousCustomers: ambiguous,
    notes: [
      "No customer rows were inserted or updated.",
      "Ambiguous groups are intentionally not auto-merged.",
    ],
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

  const report = await buildCustomerResolutionPreview(sources);
  report.sourceFiles = sources.files;

  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/old-erp-customer-resolution-preview-${timestampSlug()}.json`);
  const resolvedPath = writeJsonFile(reportPath, report);

  console.log("\n=== OLD_ERP Customer Resolution Preview ===\n");
  console.log(report.summary);
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
