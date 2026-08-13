#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  demandSku,
  fail,
  isActiveQueueDemandRecord,
  loadCosmosSources,
  normalizeSku,
  normalizeText,
  parseContainerLines,
  parseFloorAssignment,
  pickFirst,
  queueRecordQty,
  resolveContainerNumber,
  sumBy,
  timestampSlug,
  toInteger,
  toNumber,
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

function normalizePriority(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "NORMAL";
  if (raw.includes("critical") || raw === "p0") return "CRITICAL";
  if (raw.includes("high") || raw === "p1") return "HIGH";
  if (raw.includes("low") || raw === "p3") return "LOW";
  return "NORMAL";
}

function productSku(record) {
  return normalizeSku(pickFirst(record, ["sku", "itemCode", "partNumber"]));
}

function productWarehouseQty(record) {
  const onFloor = toNumber(record?.onFloor);
  if (Number.isFinite(onFloor)) return Number(onFloor);

  const onHand = toNumber(record?.onHand);
  if (Number.isFinite(onHand)) return Number(onHand);

  return 0;
}

function collectActiveContainers(containerDrafts) {
  const containers = [];
  const byContainerNumber = new Map();
  const incomingBySku = new Map();

  for (const raw of containerDrafts) {
    const removed = Boolean(raw?.removed === true || String(raw?.removed ?? "").toLowerCase() === "true");
    if (removed) continue;

    const inventoryStatus = String(pickFirst(raw, ["inventoryStatus", "inventory_state", "status", "inventoryState"]) ?? "").trim().toUpperCase();
    if (inventoryStatus && inventoryStatus !== "ON_ORDER") continue;

    const containerNumber = resolveContainerNumber(raw);
    if (!containerNumber) continue;

    const status = String(pickFirst(raw, ["status", "inventoryStatus", "inventoryState"]) ?? "").trim().toUpperCase() || "ON_ORDER";
    const etaPort = normalizeText(pickFirst(raw, ["portDate", "eta", "etaDate", "etaPortDate"]));
    const lifecycle = String(pickFirst(raw, ["paymentStatus", "status"]) ?? "").trim();

    const lines = parseContainerLines(raw);
    if (lines.length === 0) continue;

    const normalizedLines = lines.map((line) => ({
      sku: line.sku,
      qty: Number(line.qty ?? 0),
    }));

    for (const line of normalizedLines) {
      incomingBySku.set(line.sku, (incomingBySku.get(line.sku) ?? 0) + line.qty);
    }

    const container = {
      sourceId: normalizeText(raw?.id),
      containerNumber,
      status,
      lifecycle,
      etaPort,
      lines: normalizedLines,
    };

    containers.push(container);
    byContainerNumber.set(containerNumber, container);
  }

  return {
    containers,
    byContainerNumber,
    incomingBySku,
  };
}

function collectActiveDemand(invoiceQueueItems, activeContainers) {
  const rows = [];
  const openDemandBySku = new Map();
  const floorCommittedBySku = new Map();
  const containerCommittedBySku = new Map();
  const containerCommittedByContainerSku = new Map();
  const assignmentSummary = {
    floorTrusted: 0,
    containerTrusted: 0,
    unassigned: 0,
    ambiguous: 0,
  };
  const ambiguousAssignments = [];

  for (let i = 0; i < invoiceQueueItems.length; i += 1) {
    const record = invoiceQueueItems[i];
    if (!isActiveQueueDemandRecord(record)) continue;

    const sku = demandSku(record);
    const qty = queueRecordQty(record);
    if (!sku || qty <= 0) continue;

    openDemandBySku.set(sku, (openDemandBySku.get(sku) ?? 0) + qty);

    const assignment = parseFloorAssignment(record);
    let assignmentType = assignment.type;
    let assignmentStatus = "UNASSIGNED";

    if (assignment.type === "FLOOR") {
      floorCommittedBySku.set(sku, (floorCommittedBySku.get(sku) ?? 0) + qty);
      assignmentStatus = "TRUSTED_FLOOR";
      assignmentSummary.floorTrusted += 1;
    } else if (assignment.type === "CONTAINER" && assignment.containerId && activeContainers.byContainerNumber.has(assignment.containerId)) {
      containerCommittedBySku.set(sku, (containerCommittedBySku.get(sku) ?? 0) + qty);
      const key = `${assignment.containerId}|${sku}`;
      containerCommittedByContainerSku.set(key, (containerCommittedByContainerSku.get(key) ?? 0) + qty);
      assignmentStatus = "TRUSTED_CONTAINER";
      assignmentSummary.containerTrusted += 1;
    } else if (assignment.type === "CONTAINER") {
      assignmentStatus = "AMBIGUOUS_CONTAINER";
      assignmentSummary.ambiguous += 1;
      ambiguousAssignments.push({
        invoiceNumber: normalizeText(record?.invoiceNumber),
        customerName: normalizeText(record?.customerName),
        sku,
        qty,
        requestedContainer: assignment.containerId,
        reason: "container assignment does not map to active ON_ORDER container",
      });
      assignmentType = "CONTAINER";
    } else {
      assignmentStatus = "UNASSIGNED";
      assignmentSummary.unassigned += 1;
    }

    const queuePosition = toInteger(
      pickFirst(record, ["queuePosition", "queue_position", "queueIndex", "queueOrder", "position"]),
    );

    rows.push({
      invoiceNumber: normalizeText(record?.invoiceNumber),
      customerName: normalizeText(record?.customerName),
      sku,
      qty,
      priority: normalizePriority(record?.priorityFlag),
      currentLegacySource: normalizeText(record?.source) ?? "OLD_ERP",
      queuePosition,
      status: String(pickFirst(record, ["queueStatus", "warehouseStatus", "approvalStatus"]) ?? "").trim() || "APPROVED",
      notes: normalizeText(record?.notes)
        ?? normalizeText(record?.qboCustomerMemo)
        ?? normalizeText(record?.qboPrivateNote),
      assignmentType,
      assignmentStatus,
      assignmentContainer: assignment.containerId,
      queueItemId: normalizeText(record?.id),
      qboInvoiceId: normalizeText(record?.qboInvoiceId),
      qboEmail: normalizeText(record?.qboEmail),
      qboPhone: normalizeText(record?.qboPhone),
      qboShipAddress: normalizeText(record?.qboShipAddress),
      qboBillAddress: normalizeText(record?.qboBillAddress),
      matchedProductId: normalizeText(record?.matchedProductId),
      matchedItemCode: normalizeText(record?.matchedItemCode),
    });
  }

  return {
    rows,
    openDemandBySku,
    floorCommittedBySku,
    containerCommittedBySku,
    containerCommittedByContainerSku,
    assignmentSummary,
    ambiguousAssignments,
  };
}

function buildSkuOpeningTable({ products, incomingBySku, demand }) {
  const warehouseBySku = new Map();

  for (const product of products) {
    const sku = productSku(product);
    if (!sku) continue;

    const warehouseQty = productWarehouseQty(product);
    warehouseBySku.set(sku, warehouseQty);
  }

  const allSkus = new Set([
    ...warehouseBySku.keys(),
    ...incomingBySku.keys(),
    ...demand.openDemandBySku.keys(),
  ]);

  const rows = Array.from(allSkus).map((sku) => {
    const warehouseQty = Number(warehouseBySku.get(sku) ?? 0);
    const incomingQty = Number(incomingBySku.get(sku) ?? 0);
    const openDemand = Number(demand.openDemandBySku.get(sku) ?? 0);
    const committedFloor = Number(demand.floorCommittedBySku.get(sku) ?? 0);
    const committedContainer = Number(demand.containerCommittedBySku.get(sku) ?? 0);

    const availableNow = warehouseQty - committedFloor;
    const availableIncoming = incomingQty - committedContainer;

    return {
      sku,
      warehouseQty,
      incomingQty,
      openDemand,
      committedFloor,
      committedContainer,
      committedTotal: committedFloor + committedContainer,
      availableNow,
      availableIncoming,
      availableTotal: availableNow + availableIncoming,
      availabilityEquation: `${warehouseQty} + ${incomingQty} - ${committedFloor + committedContainer} = ${availableNow + availableIncoming}`,
    };
  });

  rows.sort((a, b) => a.sku.localeCompare(b.sku));
  return rows;
}

function buildContainerOpeningTable(containers, demand) {
  const rows = [];

  for (const container of containers) {
    for (const line of container.lines) {
      const key = `${container.containerNumber}|${line.sku}`;
      const committed = Number(demand.containerCommittedByContainerSku.get(key) ?? 0);
      rows.push({
        container: container.containerNumber,
        sku: line.sku,
        qty: line.qty,
        committed,
        available: line.qty - committed,
        etaPort: container.etaPort,
        status: container.status,
      });
    }
  }

  rows.sort((a, b) => {
    const c = a.container.localeCompare(b.container, undefined, { numeric: true });
    if (c !== 0) return c;
    return a.sku.localeCompare(b.sku);
  });

  return rows;
}

function adjustmentSummary(inventoryAdjustments) {
  const summary = {
    totalRows: inventoryAdjustments.length,
    byField: {},
    byReasonTop: [],
    warehouseRelatedRows: 0,
  };

  const reasonCounts = new Map();

  for (const row of inventoryAdjustments) {
    const field = String(row?.field ?? "UNKNOWN").trim() || "UNKNOWN";
    summary.byField[field] = (summary.byField[field] ?? 0) + 1;

    const reason = normalizeText(row?.reason) ?? "(blank)";
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);

    if (["onFloor", "onHand", "available", "sold"].includes(field)) {
      summary.warehouseRelatedRows += 1;
    }
  }

  summary.byReasonTop = Array.from(reasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([reason, count]) => ({ reason, count }));

  return summary;
}

function queueByInvoiceWithCustomer(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = `${row.invoiceNumber ?? "NO_INVOICE"}|${row.customerName ?? "NO_CUSTOMER"}`;
    const existing = map.get(key) ?? {
      invoice: row.invoiceNumber,
      customer: row.customerName,
      lineCount: 0,
      qtyTotal: 0,
      priorityOrder: new Set(),
      queueLines: [],
    };

    existing.lineCount += 1;
    existing.qtyTotal += Number(row.qty ?? 0);
    existing.priorityOrder.add(row.priority);
    if (existing.queueLines.length < 50) {
      existing.queueLines.push({
        sku: row.sku,
        qty: row.qty,
        status: row.status,
        assignmentStatus: row.assignmentStatus,
      });
    }

    map.set(key, existing);
  }

  return Array.from(map.values()).map((entry) => ({
    invoice: entry.invoice,
    customer: entry.customer,
    lineCount: entry.lineCount,
    qtyTotal: entry.qtyTotal,
    priorities: Array.from(entry.priorityOrder),
    queueLines: entry.queueLines,
  }));
}

export function calculateOpeningStateFromSources(sources) {
  const activeContainers = collectActiveContainers(sources.containerDrafts);
  const demand = collectActiveDemand(sources.invoiceQueueItems, activeContainers);

  const skuOpening = buildSkuOpeningTable({
    products: sources.products,
    incomingBySku: activeContainers.incomingBySku,
    demand,
  });

  const containerOpening = buildContainerOpeningTable(activeContainers.containers, demand);

  const summary = {
    sourceCounts: {
      products: sources.products.length,
      warehouseInvoices: sources.warehouseInvoices.length,
      inventoryAdjustments: sources.inventoryAdjustments.length,
      containerDrafts: sources.containerDrafts.length,
      invoiceQueueItems: sources.invoiceQueueItems.length,
    },
    activeContainerCount: activeContainers.containers.length,
    activeDemandLineCount: demand.rows.length,
    skuCount: skuOpening.length,
    totals: {
      warehouseQty: sumBy(skuOpening, "warehouseQty"),
      incomingQty: sumBy(skuOpening, "incomingQty"),
      openDemandQty: sumBy(skuOpening, "openDemand"),
      committedFloorQty: sumBy(skuOpening, "committedFloor"),
      committedContainerQty: sumBy(skuOpening, "committedContainer"),
      availableNow: sumBy(skuOpening, "availableNow"),
      availableIncoming: sumBy(skuOpening, "availableIncoming"),
      availableTotal: sumBy(skuOpening, "availableTotal"),
    },
    assignmentSummary: demand.assignmentSummary,
    adjustmentSummary: adjustmentSummary(sources.inventoryAdjustments),
  };

  return {
    summary,
    skuOpening,
    containerOpening,
    activeOrderLines: demand.rows,
    ordersGrouped: queueByInvoiceWithCustomer(demand.rows),
    ambiguousAssignments: demand.ambiguousAssignments,
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
  const reportPath = args.reportOut
    ? path.resolve(args.reportOut)
    : path.resolve(`tmp/import-reports/opening-state-dry-run-${timestampSlug()}.json`);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    sourceFiles: sources.files,
    ...openingState,
  };

  const resolvedReportPath = writeJsonFile(reportPath, report);

  console.log("\n=== OLD_ERP Opening State Dry Run ===\n");
  console.log(report.summary);
  console.log(`Report: ${resolvedReportPath}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
