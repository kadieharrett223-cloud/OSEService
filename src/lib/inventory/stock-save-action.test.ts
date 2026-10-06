import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ movements: [] as Record<string, unknown>[], audits: [] as Record<string, unknown>[] }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "synthetic-session-uuid", fullName: "Operator" }) }));
vi.mock("@/lib/admin-access", () => ({ isAdminUnlockedForUser: async () => true }));
vi.mock("@/lib/demand/canonical-customer-queue-cache", () => ({ revalidateCanonicalCustomerQueue: vi.fn() }));
vi.mock("@/lib/inventory/inventory-read-cache", () => ({ revalidateInventoryReadModelCache: vi.fn() }));
vi.mock("@/lib/orders/orders-projection-cache", () => ({ revalidateOrdersProjection: vi.fn() }));
vi.mock("@/lib/product-queue", () => ({ recalculateProductQueues: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ from: (table: string) => {
  const query = {
    select: () => query, eq: () => query,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ delta: 7 }, { delta: -1 }], error: null }).then(resolve),
    insert: async (row: Record<string, unknown>) => {
      if (table === "audit_log") state.audits.push(row);
      else {
        // Mirror production's access_users FK: session IDs are not user rows.
        if (row.actor_id != null) return { error: { message: "actor_id foreign key violation" } };
        state.movements.push(row);
      }
      return { error: null };
    },
  };
  return query;
} }) }));

import { adjustProductStockAction } from "@/app/(protected)/inventory/actions";
beforeEach(() => { state.movements.length = 0; state.audits.length = 0; });
const form = (expected: string, target: string) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ product_id: "displayed-owner", expected_on_floor_qty: expected, on_floor_qty: target, reason: "recount" })) data.set(key, value);
  return data;
};
it("saves exactly one 6-to-2 adjustment with operator audit and no invalid actor FK", async () => {
  await expect(adjustProductStockAction(form("6", "2"))).rejects.toThrow("On%20floor%20set%20to%202");
  expect(state.movements).toHaveLength(1);
  expect(state.movements[0]).toMatchObject({ product_id: "displayed-owner", delta: -4, before_qty: 6, after_qty: 2, actor_id: null });
  expect(state.audits[0].details).toMatchObject({ actor_name: "Operator", requested_qty: 2 });
});
it("records unchanged and stale attempts without any inventory movement", async () => {
  await expect(adjustProductStockAction(form("6", "6"))).rejects.toThrow("already+matches");
  await expect(adjustProductStockAction(form("7", "2"))).rejects.toThrow("outdated");
  expect(state.movements).toEqual([]);
  expect(state.audits).toHaveLength(2);
});
