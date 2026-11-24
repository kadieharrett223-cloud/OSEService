import { expect, it } from "vitest";
import { resolveProductCoverage } from "@/lib/fulfillment/suggested-allocation";
import { itemSourceCoverage } from "./item-source-coverage";

it("shows two one-unit invoice rows without repeating their shared two-unit container forecast", () => {
  const coverage = resolveProductCoverage("JACK", {
    floorAvailableByProduct: new Map([["JACK", 0]]),
    queueLinesByProduct: new Map([["JACK", [{ id: "line", product_id: "JACK", remaining_qty: 2, priority: "NORMAL", queue_position_start: 1, approved_at: null, created_at: "2026-04-21", has_live_allocation: false }]]]),
    containerSupplyByProduct: new Map([["JACK", [{ container_id: "260", container_number: "260", available_qty: 2, entered_date: null, eta_confirmed_date: null, eta_estimated_date: "2027-01-15" }]]]),
  }).lines.get("line")!;
  const before = JSON.stringify(coverage);
  const rows = itemSourceCoverage([1, 2].map(n => ({ key: String(n), lineId: "line", needed: 1, coverage })));
  expect([...rows.values()].map(r => [r.incomingQty, r.allocations[0].quantity, r.completeEtaDate])).toEqual([[1, 1, "2027-01-15"], [1, 1, "2027-01-15"]]);
  expect(JSON.stringify(coverage)).toBe(before);
});
