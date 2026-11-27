import { expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: vi.fn() }));

import { projectInventoryDisplayModel } from "./inventory-display-model";
import { dashboardAvailabilitySummary } from "./dashboard-stock";

it("keeps Dashboard and Inventory availability aligned across complete stock, demand and incoming reservations", () => {
  const products = [
    { id: "lift", sku: "LIFT", canonical_name: "Lift" },
    { id: "shadow", sku: "000001", canonical_name: "Lift" },
    { id: "free", sku: "STAND", canonical_name: "Stand" },
  ];
  const allocations = [{ source_type: "CONTAINER", container_id: "incoming", quantity: 1, allocation_status: "ALLOCATED" }];
  const line = {
    id: "open", product_id: "lift", approved_qty: 3, ordered_qty: 3, fulfilled_qty: 0,
    approval_status: "APPROVED", fulfillment_status: "UNFULFILLED", warehouse_status: "WAITING",
    fulfillment_source: "WAREHOUSE", inventory_allocations: allocations,
    shipping_orders: { id: "order", legacy_customer_name: "Customer", created_at: "2026-11-01T00:00:00Z" },
  };
  const queue = {
    canonicalLines: [line], qboInvoiceLines: [],
    queue: [{ lineId: line.id, openQty: line.ordered_qty === 3 ? 3 : 2, position: "1" }],
    queueByLineId: new Map([[line.id, { lineId: line.id, openQty: 3, position: "1", firstPaymentAt: null, invoiceDate: null, priorityDate: null, priorityDateSource: "ORDER_CREATED" }]]),
  } as unknown as Parameters<typeof projectInventoryDisplayModel>[2];
  const base = {
    products, aliases: [{ product_id: "shadow", alias: "LIFT" }], oldErpProducts: [], displayGroupData: [],
    // The late deduction must be read even when it follows the first API page.
    transactions: [
      { product_id: "lift", bucket: "ON_FLOOR", delta: 4, source_type: "RECOUNT" },
      ...Array.from({ length: 999 }, () => ({ product_id: "shadow", bucket: "ON_FLOOR", delta: 0, source_type: "ADJUSTMENT" })),
      { product_id: "lift", bucket: "ON_FLOOR", delta: -1, source_type: "SHIPMENT" },
      { product_id: "shadow", bucket: "ON_FLOOR", delta: 94, source_type: "ADJUSTMENT" },
      { product_id: "free", bucket: "ON_FLOOR", delta: 6, source_type: "RECOUNT" },
    ],
    containerLines: [{ product_id: "lift", container_id: "incoming", on_order_qty: 40, received_qty: 0,
      containers: { container_number: "266", lifecycle_status: "PRODUCTION", eta_estimated_date: "2027-01-31", eta_confirmed_date: null, port_date: null, entered_date: null } }],
  };
  const before = JSON.stringify({ base, line });
  const { displayRows } = projectInventoryDisplayModel(base, {}, queue);
  const lift = displayRows.find(row => row.sku === "LIFT")!;
  expect(lift.onFloor).toBe(3);
  expect(lift.openDemand).toBe(3);
  expect(lift.incoming).toBe(40);
  // One obligation explicitly reserves incoming supply; the other two consume floor stock.
  expect(lift.availableNow).toBe(1);
  expect(dashboardAvailabilitySummary(displayRows)).toEqual({ availableInventory: 7, lowOutOfStock: 1 });
  expect(JSON.stringify({ base, line })).toBe(before);

  const unreserved = structuredClone(line);
  unreserved.inventory_allocations = [];
  const unreservedQueue = { ...queue, canonicalLines: [unreserved] } as unknown as typeof queue;
  const second = projectInventoryDisplayModel(base, {}, unreservedQueue);
  expect(second.displayRows.find(row => row.sku === "LIFT")?.availableNow).toBe(0);
  expect(dashboardAvailabilitySummary(second.displayRows).availableInventory).toBe(6);
});

it("covers the canonical remaining quantity when the surviving local invoice line understates the obligation", () => {
  const line = {
    id: "reconciled", product_id: "jack", approved_qty: 1, ordered_qty: 1, fulfilled_qty: 0,
    approval_status: "APPROVED", fulfillment_status: "UNFULFILLED", warehouse_status: "WAITING",
    fulfillment_source: "WAREHOUSE", inventory_allocations: [],
    shipping_orders: { id: "order", created_at: "2026-08-13T00:00:00Z" },
  };
  const queue = {
    canonicalLines: [line], qboInvoiceLines: [],
    queue: [{ lineId: line.id, openQty: line.ordered_qty === 3 ? 3 : 2, position: "1" }],
    queueByLineId: new Map([[line.id, { lineId: line.id, openQty: 2, position: "1-2", firstPaymentAt: null, invoiceDate: null, priorityDate: null, priorityDateSource: "ORDER_CREATED" }]]),
  } as unknown as Parameters<typeof projectInventoryDisplayModel>[2];
  const base = {
    products: [{ id: "jack", sku: "HLCJ-6", canonical_name: "HLCJ-6 Jack" }], aliases: [], oldErpProducts: [], displayGroupData: [],
    transactions: [{ product_id: "jack", bucket: "ON_FLOOR", delta: 0, source_type: "RECOUNT" }],
    containerLines: [{ product_id: "jack", container_id: "incoming", on_order_qty: 2, received_qty: 0,
      containers: { container_number: "260", lifecycle_status: "PRODUCTION", eta_estimated_date: "2027-01-15", eta_confirmed_date: null, port_date: null, entered_date: null } }],
  };
  const before = JSON.stringify({ base, line });
  const model = projectInventoryDisplayModel(base, {}, queue);
  expect(model.coverageByLineId.get(line.id)).toMatchObject({ warehouseQty: 0, incomingQty: 2, unassignedQty: 0 });
  expect(model.coverageByLineId.get(line.id)?.allocations).toEqual([expect.objectContaining({ sourceId: "incoming", quantity: 2 })]);
  expect(JSON.stringify({ base, line })).toBe(before);
});

it("consumes one merged customer obligation once across distinct constituent invoice-line aliases", () => {
  const parent = { id: "order", source_invoice_id: "invoice", legacy_customer_name: "Customer", created_at: "2026-11-01" };
  const first = { id: "one", product_id: "jack", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING", warehouse_status: "WAITING", inventory_allocations: [], shipping_orders: parent };
  const second = { ...first, id: "two" };
  const merged = { lineId: "one", openQty: 2, position: "1-2" };
  const queue = { canonicalLines: [first, second], qboInvoiceLines: [], queue: [merged], queueByLineId: new Map([["one", merged], ["two", merged]]) } as unknown as Parameters<typeof projectInventoryDisplayModel>[2];
  const base = { products: [{ id: "jack", sku: "JACK", canonical_name: "Jack" }], aliases: [], oldErpProducts: [], displayGroupData: [], transactions: [{product_id:"jack",bucket:"ON_FLOOR",delta:1,source_type:"RECOUNT"}], containerLines: [{ product_id:"jack",container_id:"incoming",on_order_qty:1,received_qty:0,containers:{container_number:"260",lifecycle_status:"PRODUCTION",eta_confirmed_date:null,eta_estimated_date:null,port_date:null,entered_date:null} }] };
  const model = projectInventoryDisplayModel(base, {}, queue);
  expect(model.coverageByLineId.get("one")).toMatchObject({warehouseQty:1,incomingQty:1,unassignedQty:0});
  expect(model.coverageByLineId.get("two")).toBe(model.coverageByLineId.get("one"));
  expect(model.coverageByProduct.get("JACK")?.demand).toHaveLength(1);
});

it("keeps confirmed port arrival separate from ETA in incoming details and customer forecasts", () => {
  const line = { id: "open", product_id: "lift", approved_qty: 1, ordered_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "UNFULFILLED", warehouse_status: "WAITING", fulfillment_source: "WAREHOUSE", inventory_allocations: [], shipping_orders: { id: "order", created_at: "2026-11-01" } };
  const entry = { lineId: "open", openQty: 1, position: "1" };
  const queue = { canonicalLines: [line], qboInvoiceLines: [], queue: [entry], queueByLineId: new Map([["open", entry]]) } as unknown as Parameters<typeof projectInventoryDisplayModel>[2];
  const base = { products: [{ id: "lift", sku: "LIFT", canonical_name: "Lift" }], aliases: [], oldErpProducts: [], displayGroupData: [], transactions: [], containerLines: [{ product_id: "lift", container_id: "incoming", on_order_qty: 1, received_qty: 0, containers: { container_number: "256", lifecycle_status: "INBOUND", eta_estimated_date: null, eta_confirmed_date: null, port_date: "2026-12-06", entered_date: null } }] };
  const model = projectInventoryDisplayModel(base, {}, queue);
  const incoming = model.displayRows.find(row => row.sku === "LIFT")!.incomingContainers[0];
  expect(incoming.eta).not.toContain("Dec 6");
  expect(model.coverageByLineId.get("open")?.allocations[0].etaDate).toBeNull();
});
