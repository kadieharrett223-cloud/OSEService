import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  lines: [] as Array<Record<string, unknown>>,
  moved: [{ id: "open" }] as Array<{ id: string }>,
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ fullName: "Operator" })) }));
vi.mock("@/lib/product-queue", () => ({ recalculateProductQueues: vi.fn() }));
vi.mock("@/lib/demand/canonical-customer-queue-cache", () => ({ revalidateCanonicalCustomerQueue: vi.fn() }));
vi.mock("@/lib/orders/orders-projection-cache", () => ({ revalidateOrdersProjection: vi.fn() }));
vi.mock("@/lib/orders/erp-health-cache", () => ({ revalidateErpHealth: vi.fn() }));
vi.mock("@/lib/quickbooks/integration", () => ({ appendQuickbooksInternalMemoForOrder: vi.fn(), syncQuickbooksInvoice: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({
  from(table: string) {
    let mutating = false;
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      or: () => builder,
      maybeSingle: async () => ({ data: { cancellation_status: null }, error: null }),
      update: (payload: Record<string, unknown>) => { mutating = true; state.calls.push({ table, payload }); return builder; },
      insert: async (payload: Record<string, unknown>) => { state.calls.push({ table, payload }); return { error: null }; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: mutating ? state.moved : state.lines, error: null }).then(resolve),
    };
    return builder;
  },
}) }));

import { moveOrderToWarehouseAction } from "@/app/(protected)/orders/actions";
import { recalculateProductQueues } from "@/lib/product-queue";
import { revalidateOrdersProjection } from "@/lib/orders/orders-projection-cache";
const form = () => { const data = new FormData(); data.set("orderId", "11111111-1111-4111-8111-111111111111"); return data; };
beforeEach(() => {
  vi.clearAllMocks(); state.calls = []; state.moved = [{ id: "open" }];
  state.lines = [{ id: "open", product_id: "lift", approved_qty: 1, ordered_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING", warehouse_status: "ON_FLOOR" }];
});
it("stages only warehouse state, audits and refreshes the warehouse list without stock, fulfillment or queue writes", async () => {
  await expect(moveOrderToWarehouseAction(form())).rejects.toThrow("tab=warehouse&message=Order+moved");
  expect(state.calls).toEqual([
    { table: "shipping_order_lines", payload: { warehouse_status: "IN_WAREHOUSE" } },
    { table: "audit_log", payload: expect.objectContaining({ action: "ORDER_MOVED_TO_WAREHOUSE", details: { line_count: 1 } }) },
  ]);
  expect(recalculateProductQueues).not.toHaveBeenCalled();
  expect(revalidateOrdersProjection).toHaveBeenCalled();
});
it("does not downgrade picked items or replay an already staged move", async () => {
  state.lines[0].warehouse_status = "PICKED";
  await expect(moveOrderToWarehouseAction(form())).rejects.toThrow("already+in+warehouse");
  expect(state.calls).toEqual([]);
});
it("rejects completed or non-inventory lines and reports zero-row updates instead of false success", async () => {
  state.lines[0].fulfilled_qty = 1;
  await expect(moveOrderToWarehouseAction(form())).rejects.toThrow("no+open+mapped");
  state.lines[0].fulfilled_qty = 0; state.lines[0].legacy_item_code = "Shipping charge";
  await expect(moveOrderToWarehouseAction(form())).rejects.toThrow("no+open+mapped");
  state.lines[0].legacy_item_code = "4PC-6"; state.moved = [];
  await expect(moveOrderToWarehouseAction(form())).rejects.toThrow("No+open+items+were+moved");
  expect(state.calls).toHaveLength(1);
});
