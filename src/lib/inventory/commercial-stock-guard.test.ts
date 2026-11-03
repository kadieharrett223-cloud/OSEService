import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("commercial completion stock boundary", () => {
  const sql = readFileSync("supabase/migrations/20261103231024_skip_commercial_fulfillment_stock_movements.sql", "utf8");
  it("guards every insert before routing without rewriting historical business records", () => {
    expect(sql).toContain("before insert on public.inventory_transactions");
    expect(sql).toContain("inventory_transactions_00_skip_commercial_fulfillment");
    expect(sql).toContain("new.bucket<>'ON_FLOOR' or new.source_type<>'FULFILLMENT'");
    expect(sql).toContain("NON_INVENTORY_STOCK_WRITE_SKIPPED");
    expect(sql).toContain("return null;");
    expect(sql).toContain("security invoker set search_path=''");
    expect(sql).not.toMatch(/(?:update|delete from) public\.(?:inventory_transactions|products|shipping_order_lines|order_shipments|order_shipment_lines)\b/i);
  });
  it("matches complete commercial labels, not physical products mentioning shipping", () => {
    expect(sql).toContain("labels.value");
    expect(sql).toContain("'INSTALLATIONSERVICE'");
    expect(sql).not.toMatch(/\b(?:like|ilike)\b/i);
    const fixture = readFileSync("supabase/tests/commercial_fulfillment_stock.sql", "utf8");
    expect(fixture).toContain("Lift with free shipping");
    expect(fixture).toContain("Physical shipment did not deduct exactly once");
    expect(fixture).toContain("rollback;");
  });
});
