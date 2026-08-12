#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

const SOURCE_SYSTEM = "OLD_ERP";
const ORDER_SOURCE_TYPE = "INTERNAL";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    input: "",
    apply: false,
    reportOut: "",
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
    if (token === "--report-out") {
      args.reportOut = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }
  }

  return args;
}

function readJsonFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    fail(`Input file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.records)) return parsed.records;
    if (Array.isArray(parsed?.items)) return parsed.items;
    fail("Input JSON must be an array or include a records/items array.");
  } catch (error) {
    fail(`Could not parse JSON input: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return [];
}

function pickFirst(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

function normalizeText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function normalizeSku(value) {
  const sku = String(value ?? "").trim().toUpperCase();
  return sku.length > 0 ? sku : null;
}

function normalizeSkuKey(value) {
  const sku = normalizeSku(value);
  if (!sku) return null;
  const compact = sku.replace(/[^A-Z0-9]/g, "");
  return compact.length > 0 ? compact : null;
}

function toNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y";
}

function toIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function toIsoTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizePriority(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "NORMAL";
  if (raw.includes("critical") || raw === "p0") return "CRITICAL";
  if (raw.includes("high") || raw === "p1") return "HIGH";
  if (raw.includes("low") || raw === "p3") return "LOW";
  return "NORMAL";
}

function normalizeApprovalStatus(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (raw === "APPROVED") return "APPROVED";
  return null;
}

function normalizeWarehouseStatus(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  const map = new Map([
    ["IN_WAREHOUSE", "IN_WAREHOUSE"],
    ["READY_TO_SHIP", "READY_TO_SHIP"],
    ["PICKED", "PICKED"],
    ["PARTIALLY_FULFILLED", "PARTIALLY_FULFILLED"],
    ["FULFILLED", "FULFILLED"],
    ["HOLD", "HOLD"],
    ["APPROVED", "APPROVED"],
    ["PENDING_REVIEW", "PENDING_REVIEW"],
    ["ON_FLOOR", "ON_FLOOR"],
    ["ASSIGNED_TO_INBOUND", "ASSIGNED_TO_INBOUND"],
  ]);

  return map.get(raw) ?? "APPROVED";
}

function normalizeFulfillmentStatus(queueStatus, warehouseStatus) {
  const q = String(queueStatus ?? "").trim().toUpperCase();
  const w = String(warehouseStatus ?? "").trim().toUpperCase();
  if (q === "FULFILLED" || w === "FULFILLED") return "FULFILLED";
  if (q === "PARTIALLY_FULFILLED" || w === "PARTIALLY_FULFILLED") return "PARTIALLY_FULFILLED";
  return "PENDING";
}

function isWarehouseReservedStatus(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "IN_WAREHOUSE" || normalized === "ON_FLOOR";
}

function toInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function extractLineRecords(rawRecords) {
  const expanded = [];

  for (const record of rawRecords) {
    const lineArray = pickFirst(record, ["queueLines", "orderLines", "lineItems", "items", "lines"]);
    if (Array.isArray(lineArray) && lineArray.length > 0) {
      for (const line of lineArray) {
        expanded.push({
          ...record,
          ...line,
          floorAssignment: line?.floorAssignment ?? line?.floor_assignment ?? record.floorAssignment ?? record.floor_assignment,
          id: line?.id ?? line?.lineId ?? line?.queueLineId ?? record.id,
        });
      }
      continue;
    }

    expanded.push(record);
  }

  return expanded;
}

function inferAssignment(floorAssignment) {
  if (!floorAssignment || typeof floorAssignment !== "object") {
    return { type: "UNASSIGNED", containerLegacyId: null };
  }

  const type = String(floorAssignment.type ?? floorAssignment.sourceType ?? "").trim().toLowerCase();
  if (type === "container") {
    const legacyContainerId = normalizeText(
      floorAssignment.containerId
      ?? floorAssignment.container_id
      ?? floorAssignment.id
      ?? floorAssignment.sourceContainerId,
    );
    return {
      type: "CONTAINER",
      containerLegacyId: legacyContainerId,
    };
  }

  if (type === "floor") {
    return { type: "FLOOR", containerLegacyId: null };
  }

  return { type: "UNASSIGNED", containerLegacyId: null };
}

function parseRecordLine(rawRecord) {
  const sourceRecordId = normalizeText(pickFirst(rawRecord, ["id", "_id", "recordId", "lineId", "queueLineId"]));
  if (!sourceRecordId) {
    return { line: null, exclusionReason: "missingSourceId" };
  }

  const removed = toBool(pickFirst(rawRecord, ["removed", "isRemoved", "deleted"]));
  if (removed) {
    return { line: null, exclusionReason: "removedTrue" };
  }

  const approvalStatus = normalizeApprovalStatus(pickFirst(rawRecord, ["approvalStatus", "approval_status"]));
  if (approvalStatus !== "APPROVED") {
    return { line: null, exclusionReason: "approvalNotApproved" };
  }

  const queueStatus = String(pickFirst(rawRecord, ["queueStatus", "queue_status", "status"]) ?? "").trim().toUpperCase();
  if (["FULFILLED", "REMOVED", "DENIED"].includes(queueStatus)) {
    return { line: null, exclusionReason: "queueStatusExcluded" };
  }

  const rawWarehouseStatus = String(pickFirst(rawRecord, ["warehouseStatus", "warehouse_status"]) ?? "").trim().toUpperCase();
  if (["SHIPPED", "FULFILLED"].includes(rawWarehouseStatus)) {
    return { line: null, exclusionReason: "warehouseStatusExcluded" };
  }

  const qty = toNumber(pickFirst(rawRecord, ["qty", "approvedQty", "quantity", "orderedQty"]));
  if (!qty || qty <= 0) {
    return { line: null, exclusionReason: "invalidQty" };
  }

  const invoiceNumber = normalizeText(pickFirst(rawRecord, ["invoiceNumber", "invoice_number", "orderNumber"]));
  const customerName = normalizeText(pickFirst(rawRecord, ["customerName", "customer_name", "companyName", "customer"]));
  const itemCode = normalizeSku(pickFirst(rawRecord, ["itemCode", "item_code", "sku", "partNumber"]));
  const matchedItemCode = normalizeSku(pickFirst(rawRecord, ["matchedItemCode", "matched_item_code", "matchedSku"]));
  const approvedAt = toIsoTimestamp(pickFirst(rawRecord, ["approvedAt", "approved_at", "queueApprovedAt"]));
  const warehouseStatusRaw = pickFirst(rawRecord, ["warehouseStatus", "warehouse_status"]);
  const warehouseStatus = normalizeWarehouseStatus(warehouseStatusRaw);
  const priorityFlag = normalizeText(pickFirst(rawRecord, ["priorityFlag", "priority", "priority_flag"]));
  const fulfillmentMethod = normalizeText(pickFirst(rawRecord, ["fulfillmentMethod", "fulfillment_method"]));
  const expectedBy = toIsoDate(pickFirst(rawRecord, ["expectedBy", "expected_by", "promisedShipDate"]));
  const qboShippingMethod = normalizeText(pickFirst(rawRecord, ["qboShippingMethod", "shippingMethod", "qbo_shipping_method"]));
  const queuePosition = toInteger(pickFirst(rawRecord, ["queuePosition", "queue_position", "queueIndex", "queueOrder", "position"]));

  const floorAssignment = pickFirst(rawRecord, ["floorAssignment", "floor_assignment", "assignment"]);
  const assignment = inferAssignment(floorAssignment);

  const skuForMapping = matchedItemCode ?? itemCode;
  if (!skuForMapping) {
    return { line: null, exclusionReason: "missingSku" };
  }

  const sourceKey = `OLD_ERP_BACKLOG_LINE:${sourceRecordId}`;
  const orderSourceRecordId = normalizeText(pickFirst(rawRecord, ["orderId", "invoiceId", "invoiceNumber", "groupId"])) ?? sourceRecordId;
  const orderSourceKey = `OLD_ERP_BACKLOG_ORDER:${orderSourceRecordId}`;

  return {
    line: {
      sourceRecordId,
      sourceKey,
      orderSourceRecordId,
      orderSourceKey,
      invoiceNumber,
      customerName,
      itemCode,
      matchedItemCode,
      qty,
      approvedAt,
      queueStatus,
      warehouseStatus,
      priorityFlag,
      priority: normalizePriority(priorityFlag),
      floorAssignment,
      assignment,
      fulfillmentMethod,
      expectedBy,
      qboShippingMethod,
      queuePosition,
      fulfillmentStatus: normalizeFulfillmentStatus(queueStatus, warehouseStatus),
      approvalStatus,
      raw: rawRecord,
      skuForMapping,
    },
    exclusionReason: null,
  };
}

function parseLines(rawRecords) {
  const expandedRecords = extractLineRecords(rawRecords);
  const lines = [];
  const exclusionCounts = {
    missingSourceId: 0,
    removedTrue: 0,
    approvalNotApproved: 0,
    queueStatusExcluded: 0,
    warehouseStatusExcluded: 0,
    invalidQty: 0,
    missingSku: 0,
  };

  for (const record of expandedRecords) {
    const { line, exclusionReason } = parseRecordLine(record);
    if (!line) {
      if (exclusionReason && exclusionCounts[exclusionReason] !== undefined) {
        exclusionCounts[exclusionReason] += 1;
      }
      continue;
    }
    lines.push(line);
  }

  return { lines, exclusionCounts };
}

async function assertRequiredSchema(supabase) {
  const { error: orderError } = await supabase
    .from("shipping_orders")
    .select("id, source_system, source_record_id, source_key, legacy_customer_name")
    .limit(1);

  if (orderError) {
    fail(`Required backlog import columns are missing on shipping_orders. Apply migration 202608110001_old_erp_backlog_import_columns.sql first. (${orderError.message})`);
  }

  const { error: lineError } = await supabase
    .from("shipping_order_lines")
    .select("id, source_system, source_record_id, source_key, legacy_item_code, legacy_matched_item_code, legacy_queue_status, legacy_warehouse_status, legacy_priority_flag, legacy_fulfillment_method, legacy_expected_by, legacy_qbo_shipping_method, legacy_floor_assignment, legacy_container_assignment, suggested_assignment_source, suggested_container_id")
    .limit(1);

  if (lineError) {
    fail(`Required backlog import columns are missing on shipping_order_lines. Apply migration 202608110001_old_erp_backlog_import_columns.sql first. (${lineError.message})`);
  }
}

async function loadTableColumnSet(supabase, tableName, candidates) {
  const columns = new Set();

  for (const column of candidates) {
    const { error } = await supabase.from(tableName).select(column).limit(1);
    if (!error) {
      columns.add(column);
    }
  }

  return columns;
}

function filterPayloadByColumnSet(payload, columnSet) {
  const filtered = {};
  for (const [key, value] of Object.entries(payload)) {
    if (columnSet.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

async function loadProductMap(supabase) {
  const { data: products, error: productsError } = await supabase.from("products").select("id, sku");
  if (productsError) {
    fail(`Could not read products: ${productsError.message}`);
  }

  const { data: aliases, error: aliasError } = await supabase.from("product_aliases").select("product_id, alias");
  if (aliasError) {
    fail(`Could not read product aliases: ${aliasError.message}`);
  }

  const map = new Map();
  for (const product of products ?? []) {
    const sku = normalizeSku(product.sku);
    const skuKey = normalizeSkuKey(product.sku);
    if (sku) map.set(sku, product.id);
    if (skuKey) map.set(skuKey, product.id);
  }

  for (const alias of aliases ?? []) {
    const sku = normalizeSku(alias.alias);
    const skuKey = normalizeSkuKey(alias.alias);
    if (sku) map.set(sku, alias.product_id);
    if (skuKey) map.set(skuKey, alias.product_id);
  }

  return map;
}

function resolveProductId(productMap, line) {
  const direct = normalizeSku(line.skuForMapping);
  const compact = normalizeSkuKey(line.skuForMapping);
  if (direct && productMap.has(direct)) return productMap.get(direct);
  if (compact && productMap.has(compact)) return productMap.get(compact);
  return null;
}

async function loadContainerLegacyMap(supabase) {
  const { data, error } = await supabase
    .from("containers")
    .select("id, source_system, source_record_id, lifecycle_status")
    .eq("source_system", "OLD_ERP")
    .not("source_record_id", "is", null);

  if (error) {
    fail(`Could not load imported container legacy map: ${error.message}`);
  }

  const allContainers = new Map();
  const activeContainers = new Map();
  for (const row of data ?? []) {
    const legacyId = normalizeText(row.source_record_id);
    if (!legacyId) continue;
    allContainers.set(legacyId, row.id);
    if (["ORDERED", "PRODUCTION", "INBOUND"].includes(String(row.lifecycle_status ?? "").trim().toUpperCase())) {
      activeContainers.set(legacyId, row.id);
    }
  }
  return { allContainers, activeContainers };
}

function resolveSuggestedAssignment(line, activeContainerLegacyMap) {
  const legacyContainerAssignment = line.assignment.containerLegacyId ?? null;

  if (isWarehouseReservedStatus(line.warehouseStatus)) {
    return {
      source: "FLOOR",
      containerId: null,
      legacyContainerAssignment,
    };
  }

  if (line.assignment.type === "FLOOR") {
    return {
      source: "FLOOR",
      containerId: null,
      legacyContainerAssignment,
    };
  }

  if (line.assignment.type === "CONTAINER" && legacyContainerAssignment) {
    const containerId = activeContainerLegacyMap.get(legacyContainerAssignment) ?? null;
    if (containerId) {
      return {
        source: "CONTAINER",
        containerId,
        legacyContainerAssignment,
      };
    }
  }

  return {
    source: "UNASSIGNED",
    containerId: null,
    legacyContainerAssignment,
  };
}

async function findCustomerIdByName(supabase, customerName) {
  if (!customerName) return null;

  const { data: byCompany, error: companyError } = await supabase
    .from("customers")
    .select("id")
    .ilike("company_name", customerName)
    .limit(1)
    .maybeSingle();

  if (!companyError && byCompany?.id) return byCompany.id;

  const { data: byFullName, error: nameError } = await supabase
    .from("customers")
    .select("id")
    .ilike("full_name", customerName)
    .limit(1)
    .maybeSingle();

  if (!nameError && byFullName?.id) return byFullName.id;
  return null;
}

async function loadQuickbooksInvoiceMap(supabase, invoiceNumbers) {
  const normalizedInvoiceNumbers = Array.from(new Set(
    invoiceNumbers
      .map((value) => normalizeText(value))
      .filter(Boolean),
  ));

  if (normalizedInvoiceNumbers.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("qbo_invoices")
    .select("id, invoice_number, customer_id")
    .in("invoice_number", normalizedInvoiceNumbers);

  if (error) {
    fail(`Could not load QuickBooks invoice map: ${error.message}`);
  }

  const map = new Map();
  for (const row of data ?? []) {
    const invoiceNumber = normalizeText(row.invoice_number);
    if (!invoiceNumber) continue;
    map.set(invoiceNumber, {
      id: row.id,
      customerId: row.customer_id ?? null,
    });
  }

  return map;
}

function computeOrderReviewStatus(lines) {
  if (lines.every((line) => line.fulfillmentStatus === "FULFILLED")) return "FULFILLED";
  if (lines.some((line) => line.warehouseStatus === "HOLD")) return "HOLD";
  return "APPROVED";
}

function computeOrderFulfillmentStatus(lines) {
  if (lines.every((line) => line.fulfillmentStatus === "FULFILLED")) return "FULFILLED";
  if (lines.some((line) => line.fulfillmentStatus === "PARTIALLY_FULFILLED")) return "PARTIALLY_FULFILLED";
  return "PENDING";
}

function writeReport(reportPath, content) {
  const resolved = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  return resolved;
}

async function upsertOrderBySourceKey(supabase, payload) {
  const { data: existing, error: existingError } = await supabase
    .from("shipping_orders")
    .select("id")
    .eq("source_key", payload.source_key)
    .maybeSingle();

  if (existingError) {
    fail(`Could not query existing shipping order for ${payload.source_key}: ${existingError.message}`);
  }

  if (existing?.id) {
    const { data: updated, error: updateError } = await supabase
      .from("shipping_orders")
      .update(payload)
      .eq("id", existing.id)
      .select("id")
      .single();

    if (updateError || !updated?.id) {
      fail(`Could not update shipping order ${payload.source_key}: ${updateError?.message ?? "unknown error"}`);
    }

    return updated.id;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("shipping_orders")
    .insert(payload)
    .select("id")
    .single();

  if (insertError || !inserted?.id) {
    fail(`Could not insert shipping order ${payload.source_key}: ${insertError?.message ?? "unknown error"}`);
  }

  return inserted.id;
}

async function upsertLineBySourceKey(supabase, payload) {
  const { data: existing, error: existingError } = await supabase
    .from("shipping_order_lines")
    .select("id")
    .eq("source_key", payload.source_key)
    .maybeSingle();

  if (existingError) {
    fail(`Could not query existing shipping line for ${payload.source_key}: ${existingError.message}`);
  }

  if (existing?.id) {
    const { data: updated, error: updateError } = await supabase
      .from("shipping_order_lines")
      .update(payload)
      .eq("id", existing.id)
      .select("id")
      .single();

    if (updateError || !updated?.id) {
      fail(`Could not update shipping line ${payload.source_key}: ${updateError?.message ?? "unknown error"}`);
    }

    return updated.id;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("shipping_order_lines")
    .insert(payload)
    .select("id")
    .single();

  if (insertError || !inserted?.id) {
    fail(`Could not insert shipping line ${payload.source_key}: ${insertError?.message ?? "unknown error"}`);
  }

  return inserted.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    fail("Usage: node scripts/import-old-erp-backlog.mjs --input <path-to-azure-backlog.json> [--apply] [--report-out <path>]");
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    fail("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  const rawRecords = readJsonFile(args.input);
  const parsed = parseLines(rawRecords);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  if (args.apply) {
    await assertRequiredSchema(supabase);
  }

  const shippingOrderColumnSet = args.apply
    ? await loadTableColumnSet(supabase, "shipping_orders", [
      "customer_id",
      "source_invoice_id",
      "order_number",
      "source_type",
      "review_status",
      "fulfillment_status",
      "priority",
      "promised_ship_date",
      "shipping_method",
      "notes",
      "source_system",
      "source_record_id",
      "source_key",
      "legacy_customer_name",
    ])
    : new Set();

  const productMap = await loadProductMap(supabase);
  const { activeContainers: activeContainerLegacyMap } = await loadContainerLegacyMap(supabase);

  const groupedOrders = new Map();
  const unmappedSkus = new Set();
  const containerAssignmentMissing = [];
  let suggestedFloorCount = 0;
  let suggestedContainerCount = 0;
  let unassignedCount = 0;

  for (const line of parsed.lines) {
    const productId = resolveProductId(productMap, line);
    if (!productId) {
      unmappedSkus.add(line.skuForMapping);
      continue;
    }

    const suggestedAssignment = resolveSuggestedAssignment(line, activeContainerLegacyMap);

    if (suggestedAssignment.source === "FLOOR") {
      suggestedFloorCount += 1;
    } else if (suggestedAssignment.source === "CONTAINER") {
      suggestedContainerCount += 1;
    } else {
      unassignedCount += 1;
    }

    if (line.assignment.type === "CONTAINER") {
      if (!line.assignment.containerLegacyId || !activeContainerLegacyMap.has(line.assignment.containerLegacyId)) {
        containerAssignmentMissing.push({
          sourceRecordId: line.sourceRecordId,
          containerLegacyId: line.assignment.containerLegacyId,
          invoiceNumber: line.invoiceNumber,
          itemCode: line.itemCode,
        });
      }
    }

    const orderKey = line.orderSourceKey;
    const orderEntry = groupedOrders.get(orderKey) ?? {
      orderSourceKey: line.orderSourceKey,
      orderSourceRecordId: line.orderSourceRecordId,
      invoiceNumber: line.invoiceNumber,
      customerName: line.customerName,
      shippingMethod: line.qboShippingMethod,
      promisedShipDate: line.expectedBy,
      lines: [],
    };

    orderEntry.lines.push({ ...line, productId, suggestedAssignment });
    groupedOrders.set(orderKey, orderEntry);
  }

  const orderEntries = Array.from(groupedOrders.values());
  const quickbooksInvoiceMap = await loadQuickbooksInvoiceMap(
    supabase,
    orderEntries.map((order) => order.invoiceNumber),
  );
  const eligibleLineCount = orderEntries.reduce((sum, order) => sum + order.lines.length, 0);
  const totalQty = orderEntries.reduce(
    (sum, order) => sum + order.lines.reduce((lineSum, line) => lineSum + Number(line.qty ?? 0), 0),
    0,
  );

  const preview = {
    sourceRecordCount: rawRecords.length,
    excluded: parsed.exclusionCounts,
    eligibleOrderCount: orderEntries.length,
    eligibleLineCount,
    totalQty,
    suggestedFloorCount,
    suggestedContainerCount,
    unassignedCount,
    unmappedSkuCount: unmappedSkus.size,
    unmappedSkus: Array.from(unmappedSkus).sort(),
    containerAssignmentMissing,
    sampleOrders: orderEntries.slice(0, 20).map((order) => ({
      invoiceNumber: order.invoiceNumber,
      customerName: order.customerName,
      lineCount: order.lines.length,
      qty: order.lines.reduce((sum, line) => sum + Number(line.qty ?? 0), 0),
    })),
  };

  console.log("\n=== OLD_ERP Backlog Import Preview ===\n");
  console.log(preview);

  const reportBase = args.reportOut || `./tmp/import-reports/backlog-import-preview-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const previewReportPath = writeReport(reportBase, {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? "apply" : "preview",
    input: path.resolve(args.input),
    preview,
  });

  console.log(`Preview report: ${previewReportPath}`);

  if (!args.apply) {
    console.log("Preview only. Re-run with --apply to write shipping backlog.");
    return;
  }

  const results = {
    ordersUpserted: 0,
    linesUpserted: 0,
    allocationsUpserted: 0,
    suggestedContainerAssignments: suggestedContainerCount,
    suggestedFloorAssignments: suggestedFloorCount,
    linesSkippedUnmappedSku: Array.from(unmappedSkus),
    linesSkippedMissingContainerMapping: [],
  };

  for (const order of orderEntries) {
    const matchedQuickbooksInvoice = order.invoiceNumber ? quickbooksInvoiceMap.get(order.invoiceNumber) ?? null : null;
    const customerId = matchedQuickbooksInvoice?.customerId ?? await findCustomerIdByName(supabase, order.customerName);
    const orderPayload = {
      customer_id: customerId,
      source_invoice_id: matchedQuickbooksInvoice?.id ?? null,
      order_number: order.invoiceNumber,
      source_type: ORDER_SOURCE_TYPE,
      review_status: computeOrderReviewStatus(order.lines),
      fulfillment_status: computeOrderFulfillmentStatus(order.lines),
      priority: order.lines.some((line) => line.priority === "CRITICAL")
        ? "CRITICAL"
        : order.lines.some((line) => line.priority === "HIGH")
          ? "HIGH"
          : order.lines.some((line) => line.priority === "LOW")
            ? "LOW"
            : "NORMAL",
      promised_ship_date: order.promisedShipDate,
      shipping_method: order.shippingMethod,
      notes: null,
      source_system: SOURCE_SYSTEM,
      source_record_id: order.orderSourceRecordId,
      source_key: order.orderSourceKey,
      legacy_customer_name: order.customerName,
    };

    const compatibleOrderPayload = filterPayloadByColumnSet(orderPayload, shippingOrderColumnSet);

    const shippingOrderId = await upsertOrderBySourceKey(supabase, compatibleOrderPayload);
    results.ordersUpserted += 1;

    for (const line of order.lines) {
      const qty = Number(line.qty ?? 0);
      const linePayload = {
        shipping_order_id: shippingOrderId,
        qbo_invoice_line_id: null,
        product_id: line.productId,
        ordered_qty: qty,
        approved_qty: qty,
        fulfilled_qty: 0,
        cancelled_qty: 0,
        approval_status: "APPROVED",
        warehouse_status: line.warehouseStatus,
        allocation_status: "UNALLOCATED",
        fulfillment_status: line.fulfillmentStatus,
        priority: line.priority,
        queue_position_start: line.queuePosition,
        queue_position_count: null,
        approved_at: line.approvedAt,
        source_event_key: line.sourceKey,
        source_system: SOURCE_SYSTEM,
        source_record_id: line.sourceRecordId,
        source_key: line.sourceKey,
        legacy_item_code: line.itemCode,
        legacy_matched_item_code: line.matchedItemCode,
        legacy_queue_status: line.queueStatus,
        legacy_warehouse_status: normalizeText(line.raw.warehouseStatus ?? line.raw.warehouse_status),
        legacy_priority_flag: line.priorityFlag,
        legacy_fulfillment_method: line.fulfillmentMethod,
        legacy_expected_by: line.expectedBy,
        legacy_qbo_shipping_method: line.qboShippingMethod,
        legacy_floor_assignment: line.floorAssignment && typeof line.floorAssignment === "object" ? line.floorAssignment : null,
        legacy_container_assignment: line.suggestedAssignment.legacyContainerAssignment,
        suggested_assignment_source: line.suggestedAssignment.source,
        suggested_container_id: line.suggestedAssignment.containerId,
      };

      await upsertLineBySourceKey(supabase, linePayload);
      results.linesUpserted += 1;

      if (line.assignment.type === "CONTAINER" && line.suggestedAssignment.source !== "CONTAINER") {
        results.linesSkippedMissingContainerMapping.push({
          sourceRecordId: line.sourceRecordId,
          containerLegacyId: line.assignment.containerLegacyId,
        });
      }
    }
  }

  const applyReportPath = writeReport(
    previewReportPath.replace("preview", "apply"),
    {
      generatedAt: new Date().toISOString(),
      mode: "apply",
      input: path.resolve(args.input),
      preview,
      results,
    },
  );

  console.log("\n=== Backlog Import Complete ===");
  console.log(results);
  console.log(`Apply report: ${applyReportPath}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown failure");
});
