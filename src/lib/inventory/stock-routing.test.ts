import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildStockRoutes } from "./stock-routing";
const p = (id: string, sku: string, code = sku) => ({ id, sku, canonical_name: code, source_record_id: id });

describe("physical stock ledger routing", () => {
  it("posts QBO shipments to the counted legacy ledger, never a negative shadow ledger", () => {
    const routes = buildStockRoutes([p("old", "000001"),p("qbo", "2PBP-8")], [], {old:"2PBP-8"}, [
      {product_id:"old",source_type:"RECOUNT"}, {product_id:"qbo",source_type:"FULFILLMENT"},
    ]);
    expect(routes).toEqual([
      {product_id:"old",stock_product_id:"old",operational_key:"2PBP8"},
      {product_id:"qbo",stock_product_id:"old",operational_key:"2PBP8"},
    ]);
  });
  it("preserves counted zero base stock without resurrecting stale legacy receipts", () => {
    const routes = buildStockRoutes([p("old","000173"),p("base","4PXL-10")],[],{old:"4PXL-10"},[
      {product_id:"old",source_type:"CONTAINER_RECEIVED"},{product_id:"base",source_type:"RECOUNT"},
    ]);
    expect(routes.every(r => r.stock_product_id === "base")).toBe(true);
  });
  it("does not collapse existing multiple owner balances or merge parts by lift-name prefix", () => {
    const routes = buildStockRoutes([p("a","000013"),p("b","000235"),p("qbo","4PC-6"),p("seal","4PC-6 Seal Kit")],[],{a:"4PC-6",b:"4PC-6"},[
      {product_id:"a",source_type:"RECOUNT"},{product_id:"b",source_type:"RECOUNT"},
    ]);
    expect(routes.find(r=>r.product_id==="a")?.stock_product_id).toBe("a");
    expect(routes.find(r=>r.product_id==="b")?.stock_product_id).toBe("b");
    expect(routes.find(r=>r.product_id==="seal")?.stock_product_id).toBe("seal");
    expect(routes.find(r=>r.product_id==="qbo")?.stock_product_id).toBe("a");
  });
  it("has database-wide routing, serialized balances, retry guards, and no public write access", () => {
    const sql=readFileSync("supabase/migrations/20261020215755_authoritative_stock_routing.sql","utf8");
    expect(sql).toContain("before insert on public.inventory_transactions");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("new.product_id:=v_owner");
    expect(sql).toContain("new.after_qty:=v_before+new.delta");
    expect(sql).toContain("return null;");
    expect(sql).toContain("different details. No inventory changed");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("from public,anon,authenticated");
    expect(sql).toContain("security invoker set search_path=''");
    expect(sql).toContain("Shipment predates the latest stock recount");
    expect(sql).toContain("ORDER_SHIPMENT_EDIT:%");
    expect(sql).not.toMatch(/update public\.(shipping_order_lines|order_shipments|order_shipment_lines|fulfillments)/i);
  });
});
