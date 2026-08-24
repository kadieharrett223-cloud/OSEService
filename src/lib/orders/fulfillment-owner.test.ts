import { describe, expect, it } from "vitest";
import {
  isActiveSameInvoiceSiblingOwner,
  resolveSingleFulfillmentOwner,
} from "./fulfillment-owner";

const canonical = { id: "qbo-parent", source_invoice_id: "invoice-122353" };
const activeSibling = { id: "old-erp-parent", source_invoice_id: "invoice-122353" };

describe("fulfillment owner selection", () => {
  it("keeps canonical-parent selections owned by the canonical parent", () => {
    expect(resolveSingleFulfillmentOwner([
      { ownerOrderId: "qbo-parent" },
      { ownerOrderId: "qbo-parent" },
    ], "qbo-parent")).toBe("qbo-parent");
  });

  it("keeps an active same-invoice sibling line owned by its original parent", () => {
    expect(resolveSingleFulfillmentOwner([
      { ownerOrderId: "old-erp-parent" },
    ], "qbo-parent")).toBe("old-erp-parent");
    expect(isActiveSameInvoiceSiblingOwner(
      "qbo-parent",
      "old-erp-parent",
      [canonical, activeSibling],
    )).toBe(true);
  });

  it("rejects a mixed canonical and sibling selection", () => {
    expect(resolveSingleFulfillmentOwner([
      { ownerOrderId: "qbo-parent" },
      { ownerOrderId: "old-erp-parent" },
    ], "qbo-parent")).toBeNull();
  });

  it("rejects a retired sibling parent", () => {
    expect(isActiveSameInvoiceSiblingOwner(
      "qbo-parent",
      "old-erp-parent",
      [canonical, { ...activeSibling, duplicate_of_order_id: "qbo-parent" }],
    )).toBe(false);
  });

  it("rejects a parent from a different invoice", () => {
    expect(isActiveSameInvoiceSiblingOwner(
      "qbo-parent",
      "other-parent",
      [canonical, { id: "other-parent", source_invoice_id: "invoice-elsewhere" }],
    )).toBe(false);
  });
});
