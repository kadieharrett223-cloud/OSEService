import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("QuickBooks refresh fulfillment boundary", () => {
  it("never runs shipment reconciliation while refreshing an existing invoice", () => {
    const source = readFileSync("src/app/(protected)/orders/actions.ts", "utf8");
    const activation = source.split("async function activateExistingQuickbooksOrder(")[1].split("export async function refreshOrderFromQuickbooksAction")[0];
    expect(activation).not.toMatch(/reconcileConfirmedShipmentEvidence|findShipmentEvidenceRepairs/);
    expect(activation).not.toMatch(/\.from\("(?:fulfillments|inventory_transactions|order_shipment_lines|order_shipments)"\)/);
    // Only new line insertion may initialize fulfilled_qty; no existing line
    // update is allowed to mark an item shipped as a side effect of refreshing.
    for (const update of activation.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)) {
      expect(update[1]).not.toContain("fulfilled_qty");
      expect(update[1]).not.toMatch(/fulfillment_status:\s*"FULFILLED"/);
    }
  });
});
