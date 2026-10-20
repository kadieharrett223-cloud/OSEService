import { expect, it, vi } from "vitest";

vi.mock("@/lib/products/old-erp-product-identity", () => ({
  getCachedOldErpProductIdentityBySourceRecordId: async () => ({ archived: "4PHR-9X" }),
}));
const product = { id: "lift", sku: "000012", canonical_name: "HK-4PHR-9X", source_record_id: "archived" };
const line = {
  id: "line", product_id: "lift", approved_qty: 8, fulfilled_qty: 0,
  ordered_qty: 8, approval_status: "APPROVED", fulfillment_status: "PENDING",
  warehouse_status: "APPROVED", queue_position_start: 71, created_at: "2026-01-01",
  products: product, shipping_orders: { id: "order", order_number: "123", legacy_customer_name: "Customer" },
  inventory_allocations: [],
};
vi.mock("@/lib/demand/canonical-customer-queue-loader", () => ({
  loadCanonicalCustomerQueue: async () => ({
    canonicalLines: [line],
    queueByProductId: new Map([["lift", [{ lineId: "line", orderId: "order", invoice: "123", openQty: 8, position: "5-12", orderCreatedAt: "2026-01-01" }]]]),
  }),
}));
import { loadContainerReceipt } from "./container-coverage";
import { containerProductCode } from "./product-code";
import type { getSupabaseAdmin } from "@/lib/supabase/admin";

it("does not replace a current product code with a recycled archive identity", () => {
  expect(containerProductCode("000011", "HL-4PML-9", ["4PC-6"], "HK-4PC-6")).toBe("4PML-9");
  expect(containerProductCode("000173", "Model: Olympic 4PXL-10 / lift")).toBe("4PXL-10");
  expect(containerProductCode("000013", "HK-4PC-6")).toBe("4PC-6");
});

function database(received: boolean) {
  const writes = vi.fn(() => { throw new Error("Read-only display must not write"); });
  const manifest = { id: "manifest", product_id: "lift", ordered_qty: 3, on_order_qty: 3, received_qty: received ? 3 : 0, products: product };
  return {
    writes,
    from: (table: string) => {
      let fields = "";
      const query = {
        select: (selection: string) => { fields = selection; return query; },
        eq: () => query, neq: () => query, in: () => query,
        maybeSingle: () => Promise.resolve({ data: { id: "container", lifecycle_status: received ? "RECEIVED" : "INBOUND" } }),
        insert: writes, update: writes, delete: writes, upsert: writes,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: {
          products: [product], product_aliases: [{ product_id: "lift", alias: "WRONG-OLD-CODE" }],
          inventory_transactions: [], inventory_allocations: [], shipping_order_lines: [line],
          container_lines: fields.includes("containers(")
            ? [{ ...manifest, container_id: "container", containers: { container_number: "253", lifecycle_status: "INBOUND", eta_confirmed_date: "2026-10-23" } }]
            : [manifest],
        }[table] ?? [], error: null }).then(resolve),
      };
      return query;
    },
  };
}

it.each([false, true])("preserves identities and quantities while labeling %s receipt rows", async (received) => {
  const db = database(received);
  const result = await loadContainerReceipt(db as unknown as ReturnType<typeof getSupabaseAdmin>, "container");
  expect(result.productCodeById.lift).toBe("4PHR-9X");
  expect(result.forecastRows[0]).toMatchObject({ sku: "000012", productId: "lift", productCode: "4PHR-9X", queuePositionLabel: "5-12", forecastQty: received ? 0 : 3, remainingQty: 8 });
  expect(result.lines[0]).toMatchObject({ sku: "000012", expectedQty: 3, receivedQty: received ? 3 : 0 });
  if (received) expect(result.rows[0]).toMatchObject({ coveredQty: 3, remainingQty: 8, queuePosition: 71 });
  expect(db.writes).not.toHaveBeenCalled();
});
