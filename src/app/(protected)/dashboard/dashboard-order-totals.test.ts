import React from "react";
import { expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "synthetic-user" }) }));
vi.mock("@/lib/orders/orders-list-read-model", () => ({ getCachedOrdersDataset: async () => ({ tabCounts: { orders: 5000, new: 3300, warehouse: 17, partial: 102, archived: 278, cancelled: 65 } }) }));
vi.mock("@/lib/inventory/inventory-display-model", () => ({ loadInventoryDisplayModel: async () => ({ displayRows: [{ availableNow: 3, incoming: 7 }] }) }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ from(table: string) {
  if (table === "shipping_orders") throw new Error("Dashboard cannot replace complete Orders totals with a partial raw order sample");
  const q: any = { select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; }, then(resolve: any, reject: any) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); } }; return q;
} }) }));
import DashboardPage from "./page";

it("shows the same complete order totals as each linked Orders tab, even beyond 220 orders", async () => {
  vi.stubGlobal("React", React);
  const tree = await DashboardPage();
  const text = (e: any): string => typeof e === "string" || typeof e === "number" ? String(e) : Array.isArray(e) ? e.map(text).join("") : e?.props ? text(e.props.children) : "";
  const found: Record<string, string> = {};
  const visit = (e: any) => { if (!e || typeof e !== "object") return; if (Array.isArray(e)) { e.forEach(visit); return; }
    if (e.props?.href && /^(New Orders|Orders|In Warehouse|Partially Shipped|Archived|Incoming Inventory)/.test(text(e))) found[e.props.href] = text(e);
    visit(e.props?.children);
  }; visit(tree);
  expect(found["/orders?tab=orders"]).toBe("Orders5,000");
  expect(found["/orders?tab=new"]).toBe("New Orders3,300");
  expect(found["/orders?tab=warehouse"]).toBe("In Warehouse17");
  expect(found["/orders?tab=partial"]).toBe("Partially Shipped102");
  expect(found["/orders?tab=archived"]).toBe("Archived278");
  expect(found["/inventory"]).toBe("Incoming Inventory7");
});
