import { afterEach, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({ data: {} as Record<string, Array<Record<string, unknown>>>, ranges: [] as Array<{ table: string; from: number }>, fail: false }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "admin" }) }));
vi.mock("@/lib/admin-access", () => ({ isAdminUnlockedForUser: async () => true }));
vi.mock("./audit-refresh", () => ({ AuditRefresh: () => null }));
vi.mock("./print-audit-button", () => ({ PrintAuditButton: () => null }));
vi.mock("@/lib/demand/canonical-customer-queue-loader", () => ({ loadCanonicalCustomerQueue: async (options: unknown) => {
  expect(options).toEqual({ fresh: true });
  return { queueByProductId: new Map([["lift", state.data.pending ?? []]]) };
} }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ from(table: string) {
  let rows = [...(state.data[table] ?? [])], start = 0, end = 999;
  const sort: Array<{ key: string; asc: boolean }> = [];
  const value = (r: Record<string, unknown>, key: string): unknown => key.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], r);
  const q = {
    select() { return q; },
    eq(key: string, v: unknown) { rows = rows.filter(r => value(r, key) === v); return q; },
    in(key: string, values: unknown[]) { rows = rows.filter(r => values.includes(value(r, key))); return q; },
    gte(key: string, v: string) { rows = rows.filter(r => String(value(r, key)) >= v); return q; },
    lte(key: string, v: string) { rows = rows.filter(r => String(value(r, key)) <= v); return q; },
    order(key: string, options?: { ascending: boolean }) { sort.push({ key, asc: options?.ascending !== false }); return q; },
    range(a: number, b: number) { start = a; end = b; state.ranges.push({ table, from: a }); return q; },
    then(resolve: (result: unknown) => unknown) {
      rows.sort((a, b) => { for (const s of sort) { const n = String(value(a, s.key)).localeCompare(String(value(b, s.key))); if (n) return s.asc ? n : -n; } return 0; });
      return Promise.resolve({ data: state.fail && table === "inventory_transactions" ? null : rows.slice(start, end + 1), error: state.fail && table === "inventory_transactions" ? { message: "history unavailable" } : null }).then(resolve);
    },
  }; return q;
} }) }));
import Page from "./page";

afterEach(() => { vi.useRealTimers(); state.fail = false; vi.unstubAllGlobals(); });
it("reads new four-unit and one-unit shipments through zero, beyond the API row cap, without repeating deductions", async () => {
  vi.stubGlobal("React", React); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-10T19:00:00Z"));
  state.ranges = [];
  const product = { id: "lift", sku: "000002", canonical_name: "2PCF-9" };
  const movement = (id: string, delta: number, before: number, after: number, at: string, key: string | null = null) => ({ id, product_id: "lift", bucket: "ON_FLOOR", delta, before_qty: before, after_qty: after, source_event_key: key, source_type: "FULFILLMENT", reason: "Saved shipment", created_at: at });
  state.data = { products: [product], product_aliases: [{ product_id: "lift", alias: "2PCF-9" }], inventory_stock_routes: [{ product_id: "lift", stock_product_id: "lift", operational_key: "2PCF9" }], audit_log: [], fulfillments: [], pending: [{ lineId: "four", orderId: "order-four", invoice: "127426", position: "1-4", openQty: 4 }, { lineId: "one", orderId: "order-one", invoice: "127395", position: "5", openQty: 1 }], inventory_transactions: [movement("baseline", 5, 0, 5, "2026-10-14T20:00:00Z"), ...Array.from({ length: 1001 }, (_, i) => ({ ...movement(`other-${i}`, 0, 0, 0, "2026-11-01T20:00:00Z"), bucket: "SOLD" }))] };
  const render = async (period = "all") => renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ sku: "2PCF-9", period }) }));
  expect(await render()).toContain("Physical On Floor: 5");
  state.data.inventory_transactions.push(movement("four", -4, 5, 1, "2026-11-10T18:00:00Z", "ORDER_SHIPMENT:s:four:ON_FLOOR"), movement("one", -1, 1, 0, "2026-11-10T18:01:00Z", "ORDER_SHIPMENT:s:one:ON_FLOOR"));
  state.data.pending = [];
  state.data.fulfillments = [{ id: "four-event", shipping_order_line_id: "four", fulfilled_qty: 4, fulfilled_at: "2026-11-09T12:00:00Z", created_at: "2026-11-10T18:00:00Z", fulfillment_type: "SHIPMENT", source_event_key: "ORDER_SHIPMENT:s:four", shipping_order_lines: { product_id: "lift", shipping_order_id: "order-four", shipping_orders: { order_number: "127426", customers: { full_name: "Gary Ellis" } } } }];
  const html = await render("week");
  expect(html).toContain("Physical On Floor: 0"); expect(html).toContain("Gary Ellis"); expect(html).toContain("four-event");
  expect(html).toContain("5 → 1"); expect(html).toContain("1 → 0"); expect(html).toContain("Physical shipment date");
  expect(state.ranges.some(r => r.table === "inventory_transactions" && r.from >= 1000)).toBe(true);
  expect(state.data.inventory_transactions).toHaveLength(1004);
  state.fail = true;
  await expect(render()).rejects.toThrow("history unavailable");
});
