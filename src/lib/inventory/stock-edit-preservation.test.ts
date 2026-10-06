import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { authoritativeStockProductIds } from "../products/canonical-sku";

const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

describe("stock editor identity and audit preservation", () => {
  it("uses the displayed ledger owner, not the first historical catalog identity", () => {
    const owners = authoritativeStockProductIds(
      [{ id: "legacy", sku: "000008" }, { id: "live", sku: "2PCFHD-12" }],
      new Map([["legacy", "2PCFHD12"], ["live", "2PCFHD12"]]),
      new Set(["legacy", "live"]), new Set(["legacy", "live"]),
    );
    expect([...owners]).toEqual(["live"]);
    const page = source("src/app/(protected)/inventory/page.tsx");
    expect(page).toContain("group.stockProductIds.push(product.id)");
    expect(page).toContain("row.stockProductIds.length === 1 ? row.stockProductIds[0] : null");
    const editor = source("src/app/(protected)/inventory/admin-row-editor.tsx");
    expect(editor).toContain('name="product_id" value={stockProductId ?? ""}');
    expect(editor).toContain('name="expected_on_floor_qty" value={onFloor}');
    expect(editor).toContain("disabled={!stockProductId}");
  });

  it("logs attempts before the no-change exit without inserting a zero stock movement", () => {
    const action = source("src/app/(protected)/inventory/actions.ts").split("export async function adjustProductStockAction")[1].split("export async function moveCustomerQueuePositionAction")[0];
    expect(action.indexOf('action: "STOCK_EDIT_ATTEMPT"')).toBeLessThan(action.indexOf("if (delta === 0)"));
    expect(action.indexOf('outcome === "STALE_COUNT"')).toBeLessThan(action.indexOf("if (delta === 0)"));
    expect(action.indexOf('from("inventory_transactions").insert')).toBeGreaterThan(action.indexOf("if (delta === 0)"));
    expect(source("src/app/(protected)/inventory/audit/page.tsx")).toContain('eq("action", "STOCK_EDIT_ATTEMPT")');
  });
});
