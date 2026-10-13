import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stockEditContext } from "./stock-edit-context";
const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const product = (id: string, sku: string, name: string = sku) => ({ id, sku, canonical_name: name, source_record_id: null });
describe("grouped stock recount preservation", () => {
  it("keeps both displayed legacy owners instead of disabling edits", () => {
    const context = stockEditContext([product("a", "000013", "4PC-6"), product("b", "000235", "4PC-6"), product("c", "4PC-6")], [], {}, [{ product_id: "a", source_type: "ADJUSTMENT" }, { product_id: "b", source_type: "RECOUNT" }, { product_id: "c", source_type: "FULFILLMENT" }], "4PC-6");
    expect(context).toEqual({ groupIds: ["a", "b", "c"], ownerIds: ["a", "b"], targetId: "a" });
    expect(source("src/app/(protected)/inventory/page.tsx")).toContain("stockProductIds={row.stockProductIds}");
    expect(source("src/app/(protected)/inventory/admin-row-editor.tsx")).not.toContain("disabled={!stockProductId}");
  });
  it("preserves an explicitly counted zero base owner and ignores obsolete ledgers", () => {
    const context = stockEditContext([product("legacy", "000008", "2PCFHD-12"), product("live", "2PCFHD-12")], [], {}, [{ product_id: "legacy", source_type: "RECOUNT" }, { product_id: "live", source_type: "ADJUSTMENT" }], "2PCFHD-12");
    expect(context.ownerIds).toEqual(["live"]);
  });
  it("permits first counts for a product without any ledger", () => {
    expect(stockEditContext([product("new", "NEW-SKU")], [], {}, [], "NEW-SKU").targetId).toBe("new");
  });
  it("atomically audits stale and no-change outcomes without zero entries or invalid actor FK", () => {
    const sql = source("supabase/migrations/20261013154637_atomic_group_stock_recount.sql");
    expect(sql).toContain("lock table public.inventory_transactions in share row exclusive mode");
    expect(sql).toContain("if v_outcome<>'ADJUSTMENT_REQUESTED' then return v_prior");
    expect(sql).toContain("'manual-group:'||p_request_id::text,null");
    expect(sql).toContain("security invoker");
    expect(sql).toContain("from public,anon,authenticated");
    expect(source("src/app/(protected)/inventory/audit/page.tsx")).toContain('eq("action", "STOCK_EDIT_ATTEMPT")');
  });
});
