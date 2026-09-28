import { describe, expect, it } from "vitest";
import { shipmentMemoLabel } from "@/lib/orders/shipment-memo-label";

describe("shipmentMemoLabel", () => {
  it("uses the recognizable model from a numeric warehouse SKU", () => {
    expect(shipmentMemoLabel({
      sku: "000173",
      canonicalName: "Olympic 4PXL-10",
      legacyItemCode: "4PXL-10",
    })).toBe("4PXL-10");
  });

  it("keeps an ordinary customer-facing SKU", () => {
    expect(shipmentMemoLabel({ sku: "HPU1103", canonicalName: "110V power unit" })).toBe("HPU1103");
  });
});
