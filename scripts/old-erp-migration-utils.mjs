#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

export const OLD_ERP_SOURCE_SYSTEM = "OLD_ERP";
export const OLD_ERP_ARCHIVE_SOURCE_SYSTEM = "OLD_ERP_COSMOS";

export const DEFAULT_EXPORT_CONTAINERS = [
  "Products",
  "WarehouseInvoices",
  "InventoryAdjustments",
  "ContainerDrafts",
  "InvoiceQueueItems",
];

export function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

export function normalizeText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export function normalizeSku(value) {
  const sku = String(value ?? "").trim().toUpperCase();
  return sku.length > 0 ? sku : null;
}

export function normalizeSkuKey(value) {
  const sku = normalizeSku(value);
  if (!sku) return null;
  const compact = sku.replace(/[^A-Z0-9]/g, "");
  return compact.length > 0 ? compact : null;
}

export function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

export function toIsoDate(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function toBool(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y";
}

export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  return email.length > 0 ? email : null;
}

export function normalizePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  return digits.length >= 7 ? digits : null;
}

export function normalizeName(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  return raw.replace(/\s+/g, " ");
}

export function normalizeAddress(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  return raw.replace(/\s+/g, " ");
}

export function pickFirst(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

export function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function writeJsonFile(filePath, value) {
  const resolved = path.resolve(filePath);
  ensureDir(resolved);
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return resolved;
}

export function readJsonArray(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    fail(`JSON file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Could not parse JSON file ${resolved}: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.records)) return parsed.records;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.data)) return parsed.data;

  fail(`JSON file ${resolved} must be an array or contain records/items/data array.`);
  return [];
}

export function findLatestExport(exportsDir, containerName) {
  const resolvedDir = path.resolve(exportsDir);
  if (!fs.existsSync(resolvedDir)) {
    fail(`Exports directory does not exist: ${resolvedDir}`);
  }

  const prefix = `azure-${containerName}-`;
  const matches = fs.readdirSync(resolvedDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => {
      const fullPath = path.join(resolvedDir, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        fullPath,
        mtimeMs: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (matches.length === 0) {
    fail(`No export file found for ${containerName} in ${resolvedDir}.`);
  }

  return path.resolve(matches[0].fullPath);
}

export function resolveSourceFiles({ exportsDir, explicitFiles = {} }) {
  const files = {};
  for (const container of DEFAULT_EXPORT_CONTAINERS) {
    files[container] = explicitFiles[container]
      ? path.resolve(explicitFiles[container])
      : findLatestExport(exportsDir, container);
  }
  return files;
}

export function loadCosmosSources({ exportsDir, explicitFiles = {} }) {
  const files = resolveSourceFiles({ exportsDir, explicitFiles });
  return {
    files,
    products: readJsonArray(files.Products),
    warehouseInvoices: readJsonArray(files.WarehouseInvoices),
    inventoryAdjustments: readJsonArray(files.InventoryAdjustments),
    containerDrafts: readJsonArray(files.ContainerDrafts),
    invoiceQueueItems: readJsonArray(files.InvoiceQueueItems),
  };
}

export function isActiveQueueDemandRecord(record) {
  const removed = toBool(pickFirst(record, ["removed", "isRemoved", "deleted"]));
  if (removed) return false;

  const approvalStatus = String(pickFirst(record, ["approvalStatus", "approval_status"]) ?? "").trim().toUpperCase();
  if (approvalStatus !== "APPROVED") return false;

  const queueStatus = String(pickFirst(record, ["queueStatus", "queue_status", "status"]) ?? "").trim().toUpperCase();
  if (["FULFILLED", "REMOVED", "DENIED", "CANCELLED"].includes(queueStatus)) return false;

  const warehouseStatus = String(pickFirst(record, ["warehouseStatus", "warehouse_status"]) ?? "").trim().toUpperCase();
  if (["SHIPPED", "FULFILLED", "CANCELLED"].includes(warehouseStatus)) return false;

  const qty = toNumber(pickFirst(record, ["qty", "approvedQty", "orderedQty", "quantity"]));
  return Boolean(qty && qty > 0);
}

export function demandSku(record) {
  return normalizeSku(
    pickFirst(record, ["matchedItemCode", "matched_item_code", "matchedSku", "itemCode", "item_code", "sku", "partNumber"]),
  );
}

export function queueRecordQty(record) {
  return Number(toNumber(pickFirst(record, ["qty", "approvedQty", "orderedQty", "quantity"])) ?? 0);
}

export function normalizeContainerNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const digits = text.replace(/[^0-9]/g, "");
  return digits || text.toUpperCase();
}

export function resolveContainerNumber(record) {
  const direct = [
    "parsedContainerNumber",
    "containerNumber",
    "container_number",
    "number",
    "containerNo",
    "container_no",
  ];

  for (const key of direct) {
    const normalized = normalizeContainerNumber(record?.[key]);
    if (normalized) return normalized;
  }

  for (const textField of ["originalFilename", "notes", "containerLabel"]) {
    const text = String(record?.[textField] ?? "");
    const matches = Array.from(text.matchAll(/(\d{2,4})/g));
    if (matches.length > 0) {
      return normalizeContainerNumber(matches[0][1]);
    }
  }

  return null;
}

export function parseContainerLines(record) {
  const candidate = pickFirst(record, [
    "onOrderAppliedItems",
    "lineItems",
    "items",
    "containerLines",
    "contents",
    "products",
    "productLines",
  ]);

  if (!Array.isArray(candidate)) return [];

  return candidate
    .map((line) => {
      const sku = normalizeSku(pickFirst(line, ["sku", "partNumber", "part_number", "itemCode", "productCode"]));
      const qty = toNumber(pickFirst(line, ["orderedQty", "onOrderQty", "qty", "quantity"]));
      if (!sku || !qty || qty <= 0) return null;
      return {
        sku,
        qty,
      };
    })
    .filter((line) => Boolean(line));
}

export function parseFloorAssignment(record) {
  const assignment = pickFirst(record, ["floorAssignment", "floor_assignment", "assignment"]);
  if (!assignment || typeof assignment !== "object") {
    return {
      type: "UNASSIGNED",
      containerId: null,
      trusted: false,
    };
  }

  const rawType = String(assignment.type ?? assignment.sourceType ?? "").trim().toLowerCase();
  if (rawType === "floor") {
    return {
      type: "FLOOR",
      containerId: null,
      trusted: true,
    };
  }

  if (rawType === "container") {
    const containerId = normalizeContainerNumber(
      assignment.containerId
      ?? assignment.container_id
      ?? assignment.id,
    );
    return {
      type: "CONTAINER",
      containerId,
      trusted: Boolean(containerId),
    };
  }

  return {
    type: "UNASSIGNED",
    containerId: null,
    trusted: false,
  };
}

export function chunkArray(values, chunkSize) {
  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

export function createSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    fail("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

export function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function sumBy(rows, key) {
  return rows.reduce((sum, row) => sum + Number(row?.[key] ?? 0), 0);
}
