import { describe, expect, it } from "vitest";
import { createFirstPaymentProposalHash } from "./first-payment-backfill";

describe("createFirstPaymentProposalHash", () => {
  it("is stable regardless of proposal display order and changes when a proposed date changes", () => {
    const proposals = [
      { shippingOrderId: "order-b", qboInvoiceId: "qbo-b", invoice: "125958", customer: "West Hahn", proposedFirstPaymentAt: "2026-05-26", skuImpacts: [] },
      { shippingOrderId: "order-a", qboInvoiceId: "qbo-a", invoice: "125000", customer: "Other", proposedFirstPaymentAt: "2026-05-01", skuImpacts: [] },
    ];
    expect(createFirstPaymentProposalHash(proposals)).toBe(createFirstPaymentProposalHash([...proposals].reverse()));
    expect(createFirstPaymentProposalHash(proposals)).not.toBe(createFirstPaymentProposalHash([{ ...proposals[0], proposedFirstPaymentAt: "2026-05-27" }, proposals[1]]));
  });
});