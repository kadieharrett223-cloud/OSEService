import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: <T>(loader: T) => loader }));

import { loadCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-loader";
import { canonicalProductSkuKey } from "@/lib/products/canonical-sku";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { resolveProductCoverage, validateProductCoverage, type OpenQueueLine, type ProductContainerSupply } from "./suggested-allocation";

const enabled = process.env.RUN_CANONICAL_COVERAGE_AUDIT === "1";
const activeContainerStates = new Set(["ORDERED", "PRODUCTION", "INBOUND"]);

type Allocation = { shipping_order_line_id: string | null; product_id: string | null; container_id: string | null; quantity: number | null; allocation_status: string | null; source_type: string | null };

async function loadAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

describe.skipIf(!enabled)("canonical coverage production audit", () => {
  it("reports all catalog coverage invariants without writing data", async () => {
    const supabase = getSupabaseAdmin();
    const [queue, products, aliases, floorRows, containerRows, allocations] = await Promise.all([
      loadCanonicalCustomerQueue(),
      loadAll((from, to) => supabase.from("products").select("id,sku").range(from, to)),
      loadAll((from, to) => supabase.from("product_aliases").select("product_id,alias").range(from, to)),
      loadAll((from, to) => supabase.from("inventory_transactions").select("product_id,bucket,delta").eq("bucket", "ON_FLOOR").range(from, to)),
      loadAll((from, to) => supabase.from("container_lines").select("id,product_id,container_id,on_order_qty,received_qty,containers(container_number,lifecycle_status,eta_confirmed_date,eta_estimated_date,entered_date)").range(from, to)),
      loadAll((from, to) => supabase.from("inventory_allocations").select("shipping_order_line_id,product_id,container_id,quantity,allocation_status,source_type").range(from, to)),
    ]);
    const aliasesByProduct = new Map<string, string[]>();
    for (const alias of aliases as Array<{ product_id: string | null; alias: string | null }>) {
      if (alias.product_id && alias.alias) aliasesByProduct.set(alias.product_id, [...(aliasesByProduct.get(alias.product_id) ?? []), alias.alias]);
    }
    const keyByProduct = new Map((products as Array<{ id: string; sku: string | null }>).map((product) => [product.id, canonicalProductSkuKey(product.sku, aliasesByProduct.get(product.id))]));
    const liveAllocations = (allocations as Allocation[]).filter((allocation) => String(allocation.allocation_status ?? "ALLOCATED").toUpperCase() !== "RELEASED" && Number(allocation.quantity ?? 0) > 0);
    const allocationsByLine = new Map<string, Allocation[]>();
    for (const allocation of liveAllocations) {
      if (allocation.shipping_order_line_id) allocationsByLine.set(allocation.shipping_order_line_id, [...(allocationsByLine.get(allocation.shipping_order_line_id) ?? []), allocation]);
    }
    const floorByKey = new Map<string, number>();
    for (const row of floorRows as Array<{ product_id: string | null; delta: number | null }>) {
      const key = keyByProduct.get(row.product_id ?? "");
      if (key) floorByKey.set(key, (floorByKey.get(key) ?? 0) + Number(row.delta ?? 0));
    }
    const supplyByKey = new Map<string, ProductContainerSupply[]>();
    const supplyIndex = new Map<string, ProductContainerSupply>();
    for (const row of containerRows as Array<{ product_id: string | null; container_id: string | null; on_order_qty: number | null; received_qty: number | null; containers?: { container_number: string | null; lifecycle_status: string | null; eta_confirmed_date: string | null; eta_estimated_date: string | null; entered_date: string | null } | null }>) {
      const key = keyByProduct.get(row.product_id ?? "");
      if (!key || !row.container_id || !activeContainerStates.has(String(row.containers?.lifecycle_status ?? "").toUpperCase())) continue;
      const index = `${key}|${row.container_id}`;
      const qty = Math.max(0, Number(row.on_order_qty ?? 0) - Number(row.received_qty ?? 0));
      const existing = supplyIndex.get(index);
      if (existing) existing.available_qty = Math.max(existing.available_qty, qty);
      else supplyIndex.set(index, { container_id: row.container_id, container_number: row.containers?.container_number ?? null, available_qty: qty, eta_confirmed_date: row.containers?.eta_confirmed_date ?? null, eta_estimated_date: row.containers?.eta_estimated_date ?? null, entered_date: row.containers?.entered_date ?? null });
    }
    for (const [index, supply] of supplyIndex) {
      const [key] = index.split("|");
      supplyByKey.set(key, [...(supplyByKey.get(key) ?? []), supply]);
    }
    const canonicalLineById = new Map(queue.canonicalLines.map((line) => [line.id, line]));
    const demandByKey = new Map<string, OpenQueueLine[]>();
    const issues: Array<Record<string, unknown>> = [];
    for (const [productId, rows] of queue.queueByProductId) {
      const key = keyByProduct.get(productId);
      if (!key) {
        issues.push({ code: "UNMAPPED_CANONICAL_DEMAND", productId, demand: rows.reduce((sum, row) => sum + row.openQty, 0) });
        continue;
      }
      for (const row of rows) {
        const line = canonicalLineById.get(row.lineId);
        if (!line) continue;
        const allocationsForLine = allocationsByLine.get(row.lineId) ?? [];
        const floorReservedQty = allocationsForLine.filter((allocation) => allocation.source_type === "FLOOR").reduce((sum, allocation) => sum + Number(allocation.quantity ?? 0), 0);
        const start = Number.parseInt(row.position.split("-")[0] ?? "", 10);
        demandByKey.set(key, [...(demandByKey.get(key) ?? []), { id: row.lineId, product_id: key, remaining_qty: row.openQty, priority: line.priority ?? "NORMAL", queue_position_start: Number.isFinite(start) ? start : null, approved_at: null, created_at: row.orderCreatedAt ?? new Date(0).toISOString(), has_live_allocation: allocationsForLine.length > 0, fulfillment_source: line.fulfillment_source, warehouse_reserved_qty: floorReservedQty }]);
        const persistedQty = allocationsForLine.reduce((sum, allocation) => sum + Number(allocation.quantity ?? 0), 0);
        if (persistedQty > row.openQty) issues.push({ code: "PERSISTED_ALLOCATION_EXCEEDS_OPEN_DEMAND", lineId: row.lineId, expected: row.openQty, actual: persistedQty });
      }
    }
    const skuReports: Array<Record<string, unknown>> = [];
    for (const key of new Set([...demandByKey.keys(), ...floorByKey.keys(), ...supplyByKey.keys()])) {
      const resolution = resolveProductCoverage(key, { floorAvailableByProduct: new Map([[key, Math.max(0, floorByKey.get(key) ?? 0)]]), queueLinesByProduct: demandByKey, containerSupplyByProduct: supplyByKey });
      for (const diagnostic of validateProductCoverage(resolution)) issues.push({ code: diagnostic.code, sku: key, expected: diagnostic.expected, actual: diagnostic.actual, sourceId: diagnostic.sourceId });
      const demand = resolution.demand.reduce((sum, line) => sum + line.remaining_qty, 0);
      const warehouse = resolution.allocations.filter((allocation) => allocation.sourceType === "WAREHOUSE").reduce((sum, allocation) => sum + allocation.quantity, 0);
      const container = resolution.allocations.filter((allocation) => allocation.sourceType === "CONTAINER").reduce((sum, allocation) => sum + allocation.quantity, 0);
      const waiting = resolution.allocations.filter((allocation) => allocation.sourceType === "UNASSIGNED").reduce((sum, allocation) => sum + allocation.quantity, 0);
      if (demand !== warehouse + container + waiting) issues.push({ code: "DEMAND_CONSERVATION_FAILURE", sku: key, expected: demand, actual: warehouse + container + waiting });
      for (const supply of resolution.incomingSupply) {
        const forecastQty = resolution.allocations.filter((allocation) => allocation.sourceType === "CONTAINER" && allocation.sourceId === supply.container_id).reduce((sum, allocation) => sum + allocation.quantity, 0);
        const persistedQty = liveAllocations.filter((allocation) => allocation.source_type === "CONTAINER" && allocation.container_id === supply.container_id && keyByProduct.get(allocation.product_id ?? "") === key).reduce((sum, allocation) => sum + Number(allocation.quantity ?? 0), 0);
        if (forecastQty + persistedQty > supply.available_qty) issues.push({ code: "PERSISTED_CONTAINER_RESERVATION_DOUBLE_COUNTED", sku: key, containerId: supply.container_id, containerNumber: supply.container_number, expected: supply.available_qty, forecastQty, persistedQty, actual: forecastQty + persistedQty });
      }
      skuReports.push({ sku: key, openDemand: demand, onFloor: resolution.currentSupply, incoming: resolution.incomingSupply.reduce((sum, supply) => sum + supply.available_qty, 0), warehouseCovered: warehouse, containerCovered: container, waiting });
    }
    const report = { generatedAt: new Date().toISOString(), readOnly: true, contract: "Canonical demand is conserved across Warehouse, active container, and waiting coverage. Persisted allocations must not be forecast again or exceed their source supply.", totals: { canonicalSkus: skuReports.length, canonicalOpenDemand: skuReports.reduce((sum, row) => sum + Number(row.openDemand), 0), issues: issues.length, liveAllocations: liveAllocations.length, liveAllocationQty: liveAllocations.reduce((sum, allocation) => sum + Number(allocation.quantity ?? 0), 0) }, issues, skus: skuReports };
    fs.mkdirSync("tmp/import-reports", { recursive: true });
    fs.writeFileSync("tmp/import-reports/canonical-coverage-audit.json", JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ readOnly: true, totals: report.totals, issues, report: "tmp/import-reports/canonical-coverage-audit.json" }, null, 2));
    expect(report.totals.canonicalSkus).toBeGreaterThan(0);
  }, 60_000);
});