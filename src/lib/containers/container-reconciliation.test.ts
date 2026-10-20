import { expect, it, vi } from "vitest";
import type { getSupabaseAdmin } from "@/lib/supabase/admin";

const products = [
  { id: "old-pml", sku: "000011", canonical_name: "HL-4PML-9", source_record_id: "recycled-pml" },
  { id: "pml", sku: "4PML-9", canonical_name: "HL-4PML-9" },
  { id: "old-pc", sku: "000013", canonical_name: "HK-4PC-6", source_record_id: "recycled-pc" },
  { id: "pc", sku: "4PC-6", canonical_name: "HK-4PC-6" },
];
const demands = [
  ["pml-older", "old-pml", 8, "1-8"], ["pml-next", "pml", 10, "9-18"],
  ["pc-oldest", "old-pc", 10, "1-10"], ["pc-next", "pc", 10, "11-20"], ["pc-later", "pc", 16, "21-36"],
] as const;
const canonicalLines = demands.map(([id, productId, quantity]) => ({
  id, product_id: productId, legacy_item_code: productId.includes("pml") ? "4PML-9" : "4PC-6",
  approved_qty: quantity, ordered_qty: quantity, fulfilled_qty: 0,
  approval_status: "APPROVED", fulfillment_status: "PENDING", warehouse_status: "APPROVED",
  products: products.find((p) => p.id === productId), shipping_orders: { id, order_number: id, legacy_customer_name: id },
  inventory_allocations: [], created_at: "2026-01-01",
}));
vi.mock("@/lib/products/old-erp-product-identity", () => ({
  getCachedOldErpProductIdentityBySourceRecordId: async () => ({ "recycled-pml": "4PC-6", "recycled-pc": "2PDDA-10" }),
}));
vi.mock("@/lib/demand/canonical-customer-queue-loader", () => ({
  loadCanonicalCustomerQueue: async () => ({ canonicalLines, queueByProductId: new Map(products.map((p) => [p.id,
    demands.filter(([, id]) => id === p.id).map(([lineId, , openQty, position]) => ({ lineId, orderId: lineId, invoice: lineId, openQty, position, orderCreatedAt: "2026-01-01" })),
  ])) }),
}));
import { loadContainerReceipt } from "./container-coverage";

function database(targetEta = "2026-10-27") {
  const writes = vi.fn(() => { throw new Error("Reconciliation must not write physical state"); });
  const manifest = [
    { id: "pml-manifest", product_id: "pml", ordered_qty: 12, on_order_qty: 12, received_qty: 0, products: products[1] },
    { id: "pc-manifest", product_id: "pc", ordered_qty: 20, on_order_qty: 20, received_qty: 0, products: products[3] },
  ];
  const supply = [
    { product_id: "old-pml", container_id: "244", on_order_qty: 12, received_qty: 0, containers: { container_number: "244", lifecycle_status: "INBOUND", eta_estimated_date: "2026-10-19" } },
    ...manifest.map((m) => ({ ...m, container_id: "254", containers: { container_number: "254", lifecycle_status: "INBOUND", eta_estimated_date: targetEta, entered_date: "2026-08-24" } })),
    { product_id: "pc", container_id: "245", on_order_qty: 40, received_qty: 0, containers: { container_number: "245", lifecycle_status: "INBOUND", eta_estimated_date: "2026-11-11" } },
  ];
  return { writes, from: (table: string) => {
    let selection = "";
    const query = {
      select: (fields: string) => { selection = fields; return query; }, eq: () => query, neq: () => query, in: () => query,
      maybeSingle: async () => ({ data: { id: "254", lifecycle_status: "INBOUND" } }),
      insert: writes, update: writes, upsert: writes, delete: writes,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: {
        products, product_aliases: [], inventory_transactions: [], inventory_allocations: [],
        shipping_order_lines: canonicalLines, container_lines: selection.includes("containers(") ? supply : manifest,
      }[table] ?? [], error: null }).then(resolve),
    };
    return query;
  } };
}

it("reconciles legacy/current customer rows with each manifest product without mixing products or exceeding capacity", async () => {
  const db = database();
  const snapshot = JSON.stringify(canonicalLines);
  const result = await loadContainerReceipt(db as unknown as ReturnType<typeof getSupabaseAdmin>, "254");
  const covered = result.forecastRows.filter((r) => r.forecastQty > 0);
  expect(covered.map((r) => [r.lineId, r.productCode, r.queuePositionLabel, r.forecastQty])).toEqual([
    ["pc-oldest", "4PC-6", "1-10", 10], ["pml-next", "4PML-9", "9-18", 6], ["pc-next", "4PC-6", "11-20", 10],
  ]);
  expect(result.lines.map((l) => [l.productId, l.forecastCoverageQty])).toEqual([["pml", 6], ["pc", 20]]);
  expect(covered.reduce((sum, r) => sum + r.forecastQty, 0)).toBe(result.lines.reduce((sum, l) => sum + l.forecastCoverageQty, 0));
  for (const l of result.lines) expect(l.forecastCoverageQty).toBeLessThanOrEqual(l.expectedQty);
  expect(JSON.stringify(canonicalLines)).toBe(snapshot);
  expect(db.writes).not.toHaveBeenCalled();
});

it("reforecasts after an arrival changes rather than consuming the same customers on both containers", async () => {
  const db = database("2026-11-30");
  const result = await loadContainerReceipt(db as unknown as ReturnType<typeof getSupabaseAdmin>, "254");
  expect(result.forecastRows.filter((r) => r.productCode === "4PC-6").reduce((sum, r) => sum + r.forecastQty, 0)).toBe(0);
  expect(result.lines.find((l) => l.productId === "pc")?.forecastCoverageQty).toBe(0);
  expect(db.writes).not.toHaveBeenCalled();
});
