import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { shouldMoveWarehouseInventory } from "./fulfillment-source";

it("keeps every remaining physical line selectable regardless of Customer Not Ready source", () => {
  const page = readFileSync("src/app/(protected)/orders/[id]/page.tsx", "utf8");
  const checkbox = page.split("<ShipmentSelectionCheckbox")[0].split("\n").at(-1)!;
  expect(checkbox).toContain("remainingQty > 0");
  expect(checkbox).not.toContain("CUSTOMER_NOT_READY");
});
it("shows a completion form instead of blocking the line", () => {
  const panel = readFileSync("src/app/(protected)/orders/[id]/line-fulfillment-panel.tsx", "utf8");
  expect(panel).toContain('fulfillmentSource === "OTHER" || fulfillmentSource === "CUSTOMER_NOT_READY"');
  expect(panel).toContain("Complete Fulfillment");
  expect(panel).not.toContain("change the fulfillment source before recording");
});
it("uses the existing non-stock path for both completion and edit without rewriting the saved source", () => {
  expect(shouldMoveWarehouseInventory("CUSTOMER_NOT_READY")).toBe(false);
  const migration = readFileSync("supabase/migrations/20261015170309_customer_not_ready_nonstock_completion.sql", "utf8");
  expect(migration).toContain("'complete_order_shipment', 'edit_order_shipment'");
  expect(migration).toContain("then ''OTHER'' else");
  expect(migration).not.toMatch(/update\s+public\./i);
  const action = readFileSync("src/app/(protected)/orders/actions.ts", "utf8");
  expect(action.match(/const source = savedSource === "CUSTOMER_NOT_READY" \? "OTHER" : savedSource/g)).toHaveLength(2);
  expect(action).not.toContain("Change+the+fulfillment+source+before+shipping");
});
