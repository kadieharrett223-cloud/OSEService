import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { dashboardStockSummary } from "./dashboard-stock";
const sql = readFileSync("supabase/migrations/20261103195812_initialize_new_product_stock_route.sql", "utf8");

it("keeps a newly routed zero-stock product from breaking the dashboard or changing existing totals", () => {
  const products = [{ id: "old", sku: "LIFT" }, { id: "new", sku: "2PAS-10" }];
  const routes = [{ product_id: "old", stock_product_id: "old", operational_key: "LIFT" }, { product_id: "new", stock_product_id: "new", operational_key: "2PAS10" }];
  expect(dashboardStockSummary(products, [{ product_id: "old", bucket: "ON_FLOOR", delta: 19 }], routes)).toEqual({ onFloorInventory: 19, availableInventory: 19, lowOutOfStock: 1 });
});
it("initializes routing inside the product insert transaction, with no physical stock writes or automatic merging", () => {
  expect(sql).toMatch(/after insert on public\.products/i);
  expect(sql).toContain("values(new.id,new.id,v_key)");
  expect(sql).toContain("pg_advisory_xact_lock");
  expect(sql).toContain("where operational_key=v_key");
  expect(sql).toContain("raise exception");
  expect(sql).toContain("security invoker set search_path=''");
  expect(sql).toContain("from public,anon,authenticated");
  expect(sql).not.toMatch(/(?:insert into|update|delete from) public\.(?:inventory_transactions|fulfillments|inventory_allocations|shipping_order_lines)/i);
});
it("expires the dashboard dataset when product or stock changes invalidate inventory", () => {
  const page = readFileSync("src/app/(protected)/dashboard/page.tsx", "utf8");
  expect(page).toContain("tags: [INVENTORY_READ_MODEL_CACHE_TAG]");
  expect(page).toContain("dashboard-read-model-stock-owners-v3");
});
