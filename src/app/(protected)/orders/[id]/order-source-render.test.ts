import React from "react";
import { expect, it, vi } from "vitest";
import { resolveProductCoverage } from "@/lib/fulfillment/suggested-allocation";

const fixture = vi.hoisted(() => ({ db: null as any, model: null as any }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "synthetic-user" }) }));
vi.mock("@/lib/admin-access", () => ({ isAdminUnlockedForUser: async () => false }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => fixture.db }));
vi.mock("@/lib/inventory/inventory-display-model", () => ({ loadInventoryDisplayModel: async () => fixture.model }));
import OrderPage from "./page";

it("never borrows another product's shipment controls for an unmapped invoice row", async () => {
  vi.stubGlobal("React", React);
  const line = { id: "tray-line", shipping_order_id: "order", product_id: "tray", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0,
    approval_status: "APPROVED", fulfillment_status: "PENDING", warehouse_status: "APPROVED", fulfillment_source: "WAREHOUSE", legacy_item_code: "TRAY", queue_position_start: 1,
    products: { sku: "TRAY", canonical_name: "TRAY adapter for UNKNOWN-LIFT" }, inventory_allocations: [] };
  const invoice = { id: "invoice", invoice_number: "TEST", invoice_date: "2026-11-01", payment_status: "PAID", raw_payload: { Line: [
    { Id: "1", DetailType: "SalesItemLineDetail", Description: "Unmapped lift", SalesItemLineDetail: { Qty: 1, ItemRef: { name: "UNKNOWN-LIFT" } } },
    { Id: "2", DetailType: "SalesItemLineDetail", Description: "Tray", SalesItemLineDetail: { Qty: 1, ItemRef: { name: "TRAY" } } },
  ] } };
  const order = { id: "order", order_number: "TEST", source_invoice_id: "invoice", source_type: "QBO_INVOICE", review_status: "APPROVED", created_at: "2026-11-01", legacy_customer_name: "Synthetic customer", qbo_invoices: invoice, shipping_order_lines: [line] };
  const data: Record<string, any[]> = { shipping_orders: [order], shipping_order_lines: [line], qbo_invoices: [invoice], products: [{ id: "tray", ...line.products }] };
  fixture.db = { from(table: string) { let rows = [...(data[table] ?? [])], limit = 1000;
    const q: any = { select() { return q; }, eq(k: string, v: unknown) { rows = rows.filter(r => r[k] === v); return q; }, in(k: string, values: unknown[]) { rows = rows.filter(r => values.includes(r[k])); return q; }, order() { return q; }, limit(n: number) { limit = n; return q; }, maybeSingle() { return Promise.resolve({ data: rows[0] ?? null, error: null }); }, then(resolve: any, reject: any) { return Promise.resolve({ data: rows.slice(0, limit), error: null }).then(resolve, reject); } }; return q;
  } };
  const resolution = resolveProductCoverage("TRAY", { floorAvailableByProduct: new Map([["TRAY", 1]]), queueLinesByProduct: new Map([["TRAY", [{ id: line.id, product_id: "TRAY", remaining_qty: 1, priority: "NORMAL", queue_position_start: 1, approved_at: null, created_at: "2026-11-01", has_live_allocation: false }]]]), containerSupplyByProduct: new Map() });
  fixture.model = { coverageByLineId: resolution.lines, coverageByProduct: new Map([["TRAY", resolution]]), containerSupplyByProduct: new Map(), canonicalProductKeyById: new Map([["tray", "TRAY"]]), canonicalQueue: { queueByLineId: new Map([[line.id, { position: "1" }]]), queueByLogicalDemandKey: new Map() } };
  const tree = await OrderPage({ params: Promise.resolve({ id: "order" }), searchParams: Promise.resolve({}) });
  const rows: Array<{ text: string; selections: string[] }> = [];
  const text = (e: any): string => typeof e === "string" || typeof e === "number" ? String(e) : Array.isArray(e) ? e.map(text).join("") : e?.props ? text(e.props.children) : "";
  const visit = (e: any) => { if (!e || typeof e !== "object") return; if (Array.isArray(e)) { e.forEach(visit); return; }
    if (e.type === "summary" && String(e.props.className).includes("grid-cols-")) {
      const selections: string[] = [];
      const find = (x: any) => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(find); return; } if (x.props?.line?.ownerOrderId) selections.push(x.props.line.id); find(x.props?.children); }; find(e);
      rows.push({ text: text(e), selections });
    } visit(e.props?.children);
  }; visit(tree);
  expect(rows.find(r => r.text.includes("UNKNOWN-LIFT"))?.selections).toEqual([]);
  expect(rows.find(r => r.text.startsWith("TRAY"))?.selections).toEqual(["tray-line"]);
});
