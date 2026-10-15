import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  row: {} as Record<string, unknown>,
  saved: [{ id: "line" }] as Array<{ id: string }>,
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
    if (!["shipping_orders", "shipping_order_lines", "audit_log"].includes(table)) throw new Error(`Forbidden table ${table}`);
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: table === "shipping_orders" ? { cancellation_status: null } : state.row, error: null }),
      update: (payload: Record<string, unknown>) => { state.calls.push({ table, payload }); return builder; },
      insert: async (payload: Record<string, unknown>) => { state.calls.push({ table, payload }); return { error: null }; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: state.saved, error: null }).then(resolve),
    };
    return builder;
  },
}) }));
import { updateCustomerQueuePauseAction } from "@/app/(protected)/orders/actions";
import { revalidateOrdersProjection } from "./orders-projection-cache";
const form = (operation = "pause", reason = "Customer not ready") => {
  const data = new FormData();
  data.set("orderId", "11111111-1111-4111-8111-111111111111"); data.set("lineId", "line");
  data.set("queue_operation", operation); data.set("queue_pause_reason", reason);
  return data;
};
beforeEach(() => {
  vi.clearAllMocks(); state.calls = []; state.saved = [{ id: "line" }];
  state.row = { id: "line", approved_qty: 4, ordered_qty: 4, fulfilled_qty: 0, fulfillment_status: "PENDING", customer_queue_paused: false, customer_queue_pause_reason: null };
});
it("pauses metadata only, audits, and invalidates all shared projections", async () => {
  await expect(updateCustomerQueuePauseAction(form())).rejects.toThrow("Item+paused+on+Customer+Lists");
  expect(state.calls).toEqual([
    { table: "shipping_order_lines", payload: { customer_queue_paused: true, customer_queue_pause_reason: "Customer not ready" } },
    { table: "audit_log", payload: expect.objectContaining({ action: "CUSTOMER_QUEUE_PAUSED", details: expect.objectContaining({ line_id: "line", previous_paused: false, paused: true }) }) },
  ]);
  expect(revalidateOrdersProjection).toHaveBeenCalledOnce();
});
it("resumes without changing original priority, stock, allocation, or fulfillment", async () => {
  state.row.customer_queue_paused = true; state.row.customer_queue_pause_reason = "Not ready";
  await expect(updateCustomerQueuePauseAction(form("resume"))).rejects.toThrow("original+order+priority");
  expect(state.calls[0]).toEqual({ table: "shipping_order_lines", payload: { customer_queue_paused: false, customer_queue_pause_reason: null } });
  expect(state.calls[1].payload.action).toBe("CUSTOMER_QUEUE_RESUMED");
});
it("rejects blank reasons and closed items before any write", async () => {
  await expect(updateCustomerQueuePauseAction(form("pause", " "))).rejects.toThrow("Enter+a+reason");
  state.row.fulfilled_qty = 4;
  await expect(updateCustomerQueuePauseAction(form())).rejects.toThrow("Only+remaining");
  expect(state.calls).toEqual([]);
});
it("does not report false success on stale or missing updates or replay writes", async () => {
  state.saved = [];
  await expect(updateCustomerQueuePauseAction(form())).rejects.toThrow("Item%20changed");
  expect(state.calls).toHaveLength(1);
  state.calls = []; state.row.customer_queue_paused = true;
  await expect(updateCustomerQueuePauseAction(form())).rejects.toThrow("already+paused");
  expect(state.calls).toEqual([]);
});
