import { beforeEach, expect, it, vi } from "vitest";
const orderId = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted(() => ({ calls: [] as Array<{ table: string; operation: string; payload?: Record<string, unknown> }>, saved: [{ id: "line" }] as Array<{ id: string }> }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ fullName: "Operator" })) }));
vi.mock("@/lib/product-queue", () => ({ recalculateProductQueues: vi.fn() }));
vi.mock("@/lib/demand/canonical-customer-queue-cache", () => ({ revalidateCanonicalCustomerQueue: vi.fn() }));
vi.mock("@/lib/orders/erp-health-cache", () => ({ revalidateErpHealth: vi.fn() }));
vi.mock("@/lib/orders/orders-projection-cache", () => ({ revalidateOrdersProjection: vi.fn() }));
vi.mock("@/lib/quickbooks/integration", () => ({ appendQuickbooksInternalMemoForOrder: vi.fn(), syncQuickbooksInvoice: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ from(table: string) {
  if (!["shipping_orders", "shipping_order_lines", "inventory_allocations", "audit_log"].includes(table)) throw new Error(`Forbidden write/read ${table}`);
  const b = {
    select: () => b, eq: () => b,
    maybeSingle: async () => ({ data: table === "shipping_orders" ? { cancellation_status: null } : { id: "line", shipping_order_id: "11111111-1111-4111-8111-111111111111", product_id: "lift", approved_qty: 4, fulfilled_qty: 0, fulfillment_source: "WAREHOUSE" }, error: null }),
    delete: () => { state.calls.push({ table, operation: "delete" }); return b; },
    update: (payload: Record<string, unknown>) => { state.calls.push({ table, operation: "update", payload }); return b; },
    insert: async (payload: Record<string, unknown>) => { state.calls.push({ table, operation: "insert", payload }); return { error: null }; },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: state.saved, error: null }).then(resolve),
  }; return b;
} }) }));
import { updateOrderLineAssignmentAction } from "@/app/(protected)/orders/actions";
import { revalidateOrdersProjection } from "./orders-projection-cache";
const form = (notes = "Customer not ready") => { const data = new FormData(); data.set("orderId", orderId); data.set("lineId", "line"); data.set("assignment_source", "OTHER"); data.set("fulfillment_notes", notes); return data; };
beforeEach(() => { vi.clearAllMocks(); state.calls = []; state.saved = [{ id: "line" }]; });
it("Other saves its source and note, releases reservations, audits and refreshes all lists without a stock/shipment write", async () => {
  await expect(updateOrderLineAssignmentAction(form())).rejects.toThrow("Item+removed+from+active+Customer+Lists");
  expect(state.calls).toEqual([
    { table: "inventory_allocations", operation: "delete" },
    { table: "shipping_order_lines", operation: "update", payload: { fulfillment_source: "OTHER", fulfillment_supplier: null, fulfillment_reference: null, fulfillment_tracking: null, fulfillment_notes: "Customer not ready" } },
    { table: "shipping_order_lines", operation: "update", payload: { allocation_status: "UNALLOCATED", warehouse_status: "ON_FLOOR" } },
    { table: "audit_log", operation: "insert", payload: expect.objectContaining({ action: "ORDER_LINE_ASSIGNMENT_UPDATED", details: expect.objectContaining({ source: "OTHER", previous_source: "WAREHOUSE", notes: "Customer not ready", quantity: 0 }) }) },
  ]);
  expect(revalidateOrdersProjection).toHaveBeenCalledOnce();
});
it("requires an explanation before any write", async () => {
  await expect(updateOrderLineAssignmentAction(form(" "))).rejects.toThrow("Notes+are+required");
  expect(state.calls).toEqual([]);
});
it("reports a missing source update instead of claiming success", async () => {
  state.saved = [];
  await expect(updateOrderLineAssignmentAction(form())).rejects.toThrow("Assignment%20was%20not%20saved");
  expect(state.calls.some((call) => call.table === "audit_log")).toBe(false);
});
it("saves Customer Not Ready using the same source dropdown without requiring a second readiness control", async () => {
  const data = form(""); data.set("assignment_source", "CUSTOMER_NOT_READY");
  await expect(updateOrderLineAssignmentAction(data)).rejects.toThrow("Customer+Not+Ready+saved");
  expect(state.calls[1].payload).toEqual({ fulfillment_source: "CUSTOMER_NOT_READY", fulfillment_supplier: null, fulfillment_reference: null, fulfillment_tracking: null, fulfillment_notes: null });
  expect(state.calls.some((call) => call.table === "inventory_transactions" || call.table === "fulfillments")).toBe(false);
  expect(revalidateOrdersProjection).toHaveBeenCalledOnce();
});
