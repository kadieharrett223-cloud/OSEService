/**
 * Debug harness for the Inventory read model.
 *
 * Prints, per target SKU, the source rows that contribute to:
 *   product identity | on_floor | open_demand | incoming | customer list | next ETA
 * from BOTH the OLD_ERP Cosmos exports and the new Supabase read model, then diffs them.
 *
 * Read-only. Never mutates data.
 *
 * Usage: node scripts/debug-inventory-read-model.mjs [SKU ...]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const EXPORT_DIR = path.join(process.cwd(), "tmp", "exports");
const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ["4032S", "4PHR-9X", "HL-2PBP-8", "2PBP-8"];

function loadEnv() {
  try {
    const raw = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, "");
      if (!process.env[match[1]]) process.env[match[1]] = value;
    }
  } catch {
    // .env.local is optional when the vars are already exported.
  }
}

function normalizeSkuKey(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function latestExport(prefix) {
  const matches = readdirSync(EXPORT_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  if (!matches.length) return null;
  return path.join(EXPORT_DIR, matches[matches.length - 1]);
}

function readExport(prefix) {
  const file = latestExport(prefix);
  if (!file) return { file: null, rows: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const rows = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.documents ?? parsed.rows ?? []);
  return { file: path.basename(file), rows };
}

function pickNumber(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

const SKU_KEYS = ["itemCode", "sku", "productCode", "item", "itemNumber", "operationalItemCode", "code"];
const ON_FLOOR_KEYS = ["onFloor", "onFloorQty", "onFloorQuantity", "floorQty", "quantityOnFloor", "onHand", "onHandQty"];

function main() {
  loadEnv();

  const products = readExport("azure-Products-");
  const queueItems = readExport("azure-InvoiceQueueItems-");
  const containers = readExport("azure-ContainerDrafts-");

  console.log("=== OLD_ERP source exports ===");
  console.log(`Products:          ${products.file ?? "MISSING"} (${products.rows.length} rows)`);
  console.log(`InvoiceQueueItems: ${queueItems.file ?? "MISSING"} (${queueItems.rows.length} rows)`);
  console.log(`ContainerDrafts:   ${containers.file ?? "MISSING"} (${containers.rows.length} rows)`);
  if (products.rows[0]) console.log(`Product keys:   ${Object.keys(products.rows[0]).join(", ")}`);
  if (queueItems.rows[0]) console.log(`Queue keys:     ${Object.keys(queueItems.rows[0]).join(", ")}`);
  if (containers.rows[0]) console.log(`Container keys: ${Object.keys(containers.rows[0]).join(", ")}`);

  for (const target of TARGETS) {
    const key = normalizeSkuKey(target);
    console.log(`\n\n################ ${target} (canonical key ${key}) ################`);

    // ---- product identity ----
    const productMatches = products.rows.filter((row) => normalizeSkuKey(pickString(row, SKU_KEYS)) === key);
    console.log(`\n-- PRODUCT IDENTITY (${productMatches.length} source rows) --`);
    for (const row of productMatches) {
      console.log(
        `  id=${row.id ?? "?"} sku=${pickString(row, SKU_KEYS)} name=${pickString(row, ["name", "description", "productName"]) ?? ""} onFloor=${pickNumber(row, ON_FLOOR_KEYS)} updatedAt=${row.updatedAt ?? ""}`,
      );
    }

    // ---- on floor ----
    const oldOnFloor = productMatches.reduce((sum, row) => sum + pickNumber(row, ON_FLOOR_KEYS), 0);
    console.log(`\n-- ON FLOOR (old erp) = ${oldOnFloor}`);

    // ---- open demand + customer list ----
    // OLD_ERP open demand: approved, not removed, not yet fulfilled.
    // `fulfillmentStatus` is unused in the legacy data; `queueStatus` + `fulfilledAt` are authoritative.
    const CLOSED_QUEUE_STATUS = ["REMOVED", "FULFILLED", "CANCELLED", "COMPLETED", "SHIPPED"];
    const demandRows = queueItems.rows.filter((row) => {
      if (normalizeSkuKey(pickString(row, SKU_KEYS)) !== key) return false;
      if (row.removed === true) return false;
      if (row.fulfilledAt) return false;
      if (String(row.approvalStatus ?? "").toUpperCase() !== "APPROVED") return false;
      return !CLOSED_QUEUE_STATUS.includes(String(row.queueStatus ?? "").toUpperCase());
    });
    const oldOpenDemand = demandRows.reduce(
      (sum, row) => sum + Math.max(0, pickNumber(row, ["approvedQty", "approvedQuantity", "qty", "quantity"])),
      0,
    );
    console.log(`\n-- OPEN DEMAND (old erp) = ${oldOpenDemand} across ${demandRows.length} order lines --`);
    for (const row of demandRows.slice(0, 25)) {
      console.log(
        `  invoice=${pickString(row, ["invoiceNumber", "docNumber"]) ?? "?"} customer=${pickString(row, ["customerName", "customer"]) ?? "?"} qty=${pickNumber(row, ["approvedQty", "approvedQuantity", "qty", "quantity"])} queueStatus=${row.queueStatus ?? ""}`,
      );
    }
    if (demandRows.length > 25) console.log(`  ...${demandRows.length - 25} more`);

    // ---- incoming + next eta ----
    // OLD_ERP supply: container lines are `items[].partNumber/qty`; a container is incoming
    // while inventoryStatus === ON_ORDER and it has not been removed. ETA is the container portDate.
    const incomingRows = [];
    for (const container of containers.rows) {
      if (container.removed === true) continue;
      if (String(container.inventoryStatus ?? "").toUpperCase() !== "ON_ORDER") continue;
      const lines = Array.isArray(container.onOrderAppliedItems) && container.onOrderAppliedItems.length
        ? container.onOrderAppliedItems
        : container.items ?? [];
      for (const line of Array.isArray(lines) ? lines : []) {
        if (normalizeSkuKey(pickString(line, ["partNumber", ...SKU_KEYS])) !== key) continue;
        const qty = Math.max(0, pickNumber(line, ["qty", "quantity", "onOrderQty"]) - pickNumber(line, ["receivedQty", "received"]));
        if (qty <= 0) continue;
        incomingRows.push({
          container: pickString(container, ["parsedContainerNumber", "containerNumber", "id"]) ?? "?",
          status: pickString(container, ["inventoryStatus", "status"]) ?? "?",
          eta: pickString(container, ["portDate", "etaConfirmedDate", "etaEstimatedDate"]),
          qty,
        });
      }
    }
    incomingRows.sort((a, b) => new Date(a.eta ?? "9999-12-31") - new Date(b.eta ?? "9999-12-31"));
    const oldIncoming = incomingRows.reduce((sum, row) => sum + row.qty, 0);
    console.log(`\n-- INCOMING (old erp) = ${oldIncoming} across ${incomingRows.length} container lines --`);
    for (const row of incomingRows) console.log(`  ${row.container} qty=${row.qty} status=${row.status} eta=${row.eta ?? "none"}`);
    console.log(`-- NEXT ETA (old erp) = ${incomingRows[0] ? `${incomingRows[0].container} @ ${incomingRows[0].eta ?? "none"}` : "none"}`);

    console.log(
      `\n-- OLD ERP MATH -- on_floor=${oldOnFloor} open_demand=${oldOpenDemand} incoming=${oldIncoming} available_now=${Math.max(0, oldOnFloor - oldOpenDemand)} projected=${Math.max(0, oldOnFloor + oldIncoming - oldOpenDemand)} uncovered=${Math.max(0, oldOpenDemand - oldOnFloor - oldIncoming)}`,
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.log("\n(Supabase env not found; skipped new-ERP comparison.)");
    return;
  }

  return compareNewErp(createClient(url, serviceKey, { auth: { persistSession: false } }));
}

async function compareNewErp(supabase) {
  const [{ data: productRows }, { data: aliasRows }] = await Promise.all([
    supabase.from("products").select("id, sku, canonical_name"),
    supabase.from("product_aliases").select("product_id, alias"),
  ]);

  const operationalSku = new Map();
  for (const alias of aliasRows ?? []) {
    const candidate = String(alias.alias ?? "").trim().toUpperCase();
    if (!candidate || /^\d+$/.test(candidate)) continue;
    if (!operationalSku.has(alias.product_id)) operationalSku.set(alias.product_id, candidate);
  }

  for (const target of TARGETS) {
    const key = normalizeSkuKey(target);
    const matched = (productRows ?? []).filter((product) => {
      const display = operationalSku.get(product.id) ?? product.sku ?? "";
      return (normalizeSkuKey(display) || normalizeSkuKey(product.sku)) === key;
    });

    console.log(`\n\n=== NEW ERP :: ${target} (${matched.length} product rows in canonical group) ===`);
    if (!matched.length) continue;
    const ids = matched.map((product) => product.id);
    for (const product of matched) {
      console.log(`  product_id=${product.id} sku=${product.sku} alias=${operationalSku.get(product.id) ?? "-"} name=${product.canonical_name}`);
    }

    const [{ data: transactions }, { data: queueLines }, { data: containerLines }] = await Promise.all([
      supabase.from("inventory_transactions").select("product_id, bucket, delta").in("product_id", ids),
      supabase
        .from("shipping_order_lines")
        .select("id, product_id, approved_qty, fulfilled_qty, approval_status, priority")
        .in("product_id", ids)
        .in("approval_status", ["APPROVED", "PARTIAL", "FULFILLED"]),
      supabase
        .from("container_lines")
        .select("product_id, on_order_qty, received_qty, containers(container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date, port_date)")
        .in("product_id", ids),
    ]);

    const onFloor = (transactions ?? [])
      .filter((row) => row.bucket === "ON_FLOOR")
      .reduce((sum, row) => sum + Number(row.delta ?? 0), 0);
    const openDemand = (queueLines ?? []).reduce(
      (sum, row) => sum + Math.max(0, Number(row.approved_qty ?? 0) - Number(row.fulfilled_qty ?? 0)),
      0,
    );
    const activeContainerLines = (containerLines ?? []).filter((row) =>
      ["ORDERED", "PRODUCTION", "INBOUND"].includes(String(row.containers?.lifecycle_status ?? "").toUpperCase()),
    );
    // Container supply is per part number; duplicate legacy product identities repeat the same
    // container line, so dedupe by container number rather than summing.
    const incomingByContainer = new Map();
    for (const row of activeContainerLines) {
      const number = row.containers?.container_number;
      if (!number) continue;
      const qty = Math.max(0, Number(row.on_order_qty ?? 0) - Number(row.received_qty ?? 0));
      incomingByContainer.set(number, Math.max(incomingByContainer.get(number) ?? 0, qty));
    }
    const incoming = Array.from(incomingByContainer.values()).reduce((sum, qty) => sum + qty, 0);
    const nextEta = activeContainerLines
      .map((row) => ({
        container: row.containers?.container_number,
        eta: row.containers?.eta_confirmed_date ?? row.containers?.eta_estimated_date ?? row.containers?.port_date,
      }))
      .filter((row) => row.container)
      .sort((a, b) => String(a.eta ?? "9999").localeCompare(String(b.eta ?? "9999")))[0];

    console.log(`  on_floor=${onFloor} open_demand=${openDemand} (${(queueLines ?? []).length} lines) incoming=${incoming}`);
    console.log(`  available_now=${Math.max(0, onFloor - openDemand)} projected=${Math.max(0, onFloor + incoming - openDemand)} uncovered=${Math.max(0, openDemand - onFloor - incoming)}`);
    console.log(`  next_eta=${nextEta ? `${nextEta.container} @ ${nextEta.eta ?? "none"}` : "none"}`);
  }
}

await main();
