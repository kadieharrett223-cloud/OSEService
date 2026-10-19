import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  floor: 1,
  held: false,
  method: "SHIP",
  pinnedContainer: false,
  tableReads: [] as string[],
}));
const line = (id: string, orderId: string) => ({
  id,
  product_id: "lift",
  approved_qty: 1,
  ordered_qty: 1,
  fulfilled_qty: 0,
  approval_status: "APPROVED",
  fulfillment_status: "PENDING",
  queue_position_start: 1,
  queue_position_count: 1,
  legacy_item_code: "4PC-6",
  qbo_invoice_line_id: null,
  source_record_id: null,
  warehouse_status: "ON_FLOOR",
  fulfillment_source: null,
  products: { sku: "4PC-6", canonical_name: "4PC-6" },
  shipping_orders: {
    id: orderId,
    created_at: "2026-01-01",
    source_invoice_id: orderId,
    fulfillment_method: state.method,
    legacy_customer_name: orderId,
    qbo_invoices: { invoice_date: "2026-01-01" },
  },
  inventory_allocations: state.pinnedContainer
    ? [
        {
          source_type: "CONTAINER",
          container_id: "container",
          quantity: 1,
          allocation_status: "ALLOCATED",
        },
      ]
    : [],
});
vi.mock("@/lib/demand/canonical-customer-queue-loader", () => ({
  loadCanonicalCustomerQueue: async () => ({
    canonicalLines: [
      line("older-line", "older"),
      line("younger-line", "younger"),
    ],
    queueByLineId: new Map([
      [
        "older-line",
        {
          position: "1",
          invoice: "111",
          priorityDate: "2026-01-01",
          invoiceDate: "2026-01-01",
        },
      ],
      [
        "younger-line",
        {
          position: "2",
          invoice: "112",
          priorityDate: "2026-02-01",
          invoiceDate: "2026-02-01",
        },
      ],
    ]),
  }),
}));
vi.mock("@/lib/products/old-erp-product-identity", () => ({
  getCachedOldErpProductIdentityBySourceRecordId: async () => ({}),
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      state.tableReads.push(table);
      const data = () =>
        ({
          products: [
            {
              id: "lift",
              sku: "4PC-6",
              canonical_name: "4PC-6",
              source_record_id: null,
              inventory_group: "4-Post Lifts",
            },
          ],
          product_aliases: [],
          inventory_transactions: [
            { product_id: "lift", delta: state.floor, source_type: "RECOUNT" },
          ],
          container_lines: state.pinnedContainer
            ? [
                {
                  product_id: "lift",
                  container_id: "container",
                  on_order_qty: 2,
                  received_qty: 0,
                  containers: {
                    container_number: "261",
                    lifecycle_status: "ORDERED",
                  },
                },
              ]
            : [],
          old_erp_source_records: [],
          audit_log: [],
          shipping_orders: ["older", "younger"].map((id) => ({
            id,
            payment_hold: state.held,
            delivery_address: {
              Line1: "100 Main",
              City: "Seattle",
              CountrySubDivisionCode: "WA",
              PostalCode: "98101",
            },
            qbo_invoices: { raw_payload: {} },
          })),
        })[table] ?? [];
      const query = {
        select: () => query,
        eq: () => query,
        neq: () => query,
        order: () => query,
        range: () => query,
        in: () => query,
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: data(), error: null }).then(resolve),
      };
      return query;
    },
  }),
}));
import { loadShippingGroupCandidates } from "./shipping-groups-loader";
beforeEach(() => {
  state.floor = 1;
  state.held = false;
  state.method = "SHIP";
  state.pinnedContainer = false;
  state.tableReads = [];
});
it("uses each unit once and preserves the older customer’s priority", async () => {
  const result = await loadShippingGroupCandidates();
  expect(result.candidates.map((c) => c.orderId)).toEqual(["older"]);
  expect(result.candidates[0].lifts[0].quantity).toBe(1);
});
it("never recommends zero/negative stock", async () => {
  state.floor = -2;
  expect((await loadShippingGroupCandidates()).candidates).toEqual([]);
});
it("does not take pinned incoming special orders from current floor stock", async () => {
  state.floor = 5;
  state.pinnedContainer = true;
  expect((await loadShippingGroupCandidates()).candidates).toEqual([]);
});
it("excludes payment-held and pickup orders without changing them", async () => {
  state.held = true;
  expect((await loadShippingGroupCandidates()).candidates).toEqual([]);
  state.held = false;
  state.method = "WILL_CALL";
  expect((await loadShippingGroupCandidates()).candidates).toEqual([]);
});
