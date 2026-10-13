import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ calls: [] as any[], outcome: "ADJUSTMENT_REQUESTED", unlocked: true }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "synthetic-session-uuid", fullName: "Operator" }) }));
vi.mock("@/lib/admin-access", () => ({ isAdminUnlockedForUser: async () => state.unlocked }));
vi.mock("@/lib/demand/canonical-customer-queue-cache", () => ({ revalidateCanonicalCustomerQueue: vi.fn() }));
vi.mock("@/lib/inventory/inventory-read-cache", () => ({ revalidateInventoryReadModelCache: vi.fn() }));
vi.mock("@/lib/orders/orders-projection-cache", () => ({ revalidateOrdersProjection: vi.fn() }));
vi.mock("@/lib/product-queue", () => ({ recalculateProductQueues: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/products/old-erp-product-identity", () => ({ getCachedOldErpProductIdentityBySourceRecordId: async () => ({}) }));
vi.mock("@/lib/demand/queue-query-pages", () => ({ fetchQueuePages: async () => [] }));
vi.mock("@/lib/demand/canonical-customer-queue-loader", () => ({ loadCanonicalCustomerQueue: async () => ({ canonicalLines: [] }) }));
vi.mock("@/lib/inventory/stock-edit-context", () => ({ stockEditContext: () => ({ groupIds: ["a", "b"], ownerIds: ["a", "b"], targetId: "a" }) }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ rpc: async (name: string, args: any) => { state.calls.push({ name, args }); return { data: { outcome: state.outcome, delta: args.p_target - args.p_expected }, error: null }; } }) }));
import { adjustProductStockAction } from "@/app/(protected)/inventory/actions";
beforeEach(() => { state.calls = []; state.outcome = "ADJUSTMENT_REQUESTED"; state.unlocked = true; });
const form = (expected: string, target: string) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ stock_sku: "4PC-6", stock_product_ids: '["a","b"]', request_id: "11111111-1111-4111-8111-111111111111", expected_on_floor_qty: expected, on_floor_qty: target, reason: "recount" })) data.set(key, value);
  return data;
};
it("saves a grouped recount through one atomic RPC, retaining the operator name", async () => {
  await expect(adjustProductStockAction(form("12", "0"))).rejects.toThrow("On%20floor%20set%20to%200");
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]).toMatchObject({ name: "recount_inventory_stock_group", args: { p_owner_ids: ["a", "b"], p_target_id: "a", p_expected: 12, p_target: 0, p_actor_name: "Operator" } });
});
it("handles atomic unchanged and stale outcomes without a second write", async () => {
  state.outcome = "ALREADY_MATCHES";
  await expect(adjustProductStockAction(form("12", "12"))).rejects.toThrow("already+matches");
  state.outcome = "STALE_COUNT";
  await expect(adjustProductStockAction(form("12", "0"))).rejects.toThrow("outdated");
  expect(state.calls).toHaveLength(2);
});
it("rejects a mismatched owner set, invalid quantities and non-admins before mutation", async () => {
  const data = form("12", "0"); data.set("stock_product_ids", '["b"]');
  await expect(adjustProductStockAction(data)).rejects.toThrow("identity+changed");
  await expect(adjustProductStockAction(form("12", "1.5"))).rejects.toThrow("valid+on+floor");
  state.unlocked = false;
  await expect(adjustProductStockAction(form("12", "0"))).rejects.toThrow("Admin+mode");
  expect(state.calls).toEqual([]);
});
