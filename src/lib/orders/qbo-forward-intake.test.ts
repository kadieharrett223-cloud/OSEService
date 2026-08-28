import { describe, expect, it } from "vitest";
import { selectAutomaticForwardIntakeCandidates, selectForwardIntakeReviewCandidates } from "./qbo-forward-intake-service";
import { canApproveHistoricalQboIntakeLine, classifyQboForwardIntakeLine, isInventoryDemandQuickbooksLine } from "./qbo-forward-intake";

const cleanMappedPhysicalLine = {
  isPaymentEligible: true,
  isInventoryDemandLine: true,
  hasExactExistingLine: false,
  hasTerminalOrReviewedResolution: false,
  hasMappedProduct: true,
  hasPossibleManualDuplicate: false,
  hasConflictingSkuIdentity: false,
};

describe("QBO forward intake classifier", () => {
  it("auto-imports a clean paid mapped physical line", () => {
    expect(classifyQboForwardIntakeLine(cleanMappedPhysicalLine)).toBe("AUTO_IMPORT");
  });

  it("keeps service and accounting-only rows out of inventory demand", () => {
    expect(isInventoryDemandQuickbooksLine({ qbo_sku: "Service", ordered_qty: 1 })).toBe(false);
    expect(isInventoryDemandQuickbooksLine({ qbo_sku: "Misc Charge", ordered_qty: 1 })).toBe(false);
    expect(classifyQboForwardIntakeLine({ ...cleanMappedPhysicalLine, isInventoryDemandLine: false })).toBe("NO_INVENTORY_DEMAND");
  });

  it("never duplicates an exact QBO line", () => {
    expect(classifyQboForwardIntakeLine({ ...cleanMappedPhysicalLine, hasExactExistingLine: true })).toBe("ALREADY_REPRESENTED");
  });

  it("quarantines unmapped and ambiguous physical demand", () => {
    expect(classifyQboForwardIntakeLine({ ...cleanMappedPhysicalLine, hasMappedProduct: false })).toBe("MAPPING_REVIEW");
    expect(classifyQboForwardIntakeLine({ ...cleanMappedPhysicalLine, hasPossibleManualDuplicate: true })).toBe("MANUAL_DUPLICATE_REVIEW");
    expect(classifyQboForwardIntakeLine({ ...cleanMappedPhysicalLine, hasConflictingSkuIdentity: true })).toBe("MANUAL_DUPLICATE_REVIEW");
  });

  it("keeps terminal or reviewed obligations closed", () => {
    expect(classifyQboForwardIntakeLine({ ...cleanMappedPhysicalLine, hasTerminalOrReviewedResolution: true })).toBe("CLOSED");
  });

  it("approves a historical line only when its exact live source state remains clean", () => {
    const clean = { isPaid: true, isPhysicalLine: true, hasMappedProduct: true, hasTerminalResolution: false, hasOpenRepresentation: false, hasOpenManualDuplicateReview: false, isVoided: false };
    expect(canApproveHistoricalQboIntakeLine(clean)).toBe(true);
    expect(canApproveHistoricalQboIntakeLine({ ...clean, hasOpenRepresentation: true })).toBe(false);
    expect(canApproveHistoricalQboIntakeLine({ ...clean, hasTerminalResolution: true })).toBe(false);
    expect(canApproveHistoricalQboIntakeLine({ ...clean, hasOpenManualDuplicateReview: true })).toBe(false);
    expect(canApproveHistoricalQboIntakeLine({ ...clean, isVoided: true })).toBe(false);
    expect(canApproveHistoricalQboIntakeLine({ ...clean, hasMappedProduct: false })).toBe(false);
  });

  it("selects every clean candidate for continuous intake without an invoice allowlist", () => {
    const candidates = selectAutomaticForwardIntakeCandidates([
      { qboInvoiceId: "clean", invoiceNumber: "127052", customerName: "ERP TEST - Kadie", firstPaymentAt: "2026-08-26T00:00:00.000Z", invoiceDate: "2026-08-26", decision: "AUTO_IMPORT", lines: [] },
      { qboInvoiceId: "mapping", invoiceNumber: "127083", customerName: "Chris Meehan", firstPaymentAt: "2026-08-24T00:00:00.000Z", invoiceDate: "2026-08-24", decision: "MAPPING_REVIEW", lines: [] },
      { qboInvoiceId: "service", invoiceNumber: "127014", customerName: "James Guthrie", firstPaymentAt: "2026-08-10T00:00:00.000Z", invoiceDate: "2026-08-10", decision: "NO_INVENTORY_DEMAND", lines: [] },
    ]);

    expect(candidates.map((candidate) => candidate.invoiceNumber)).toEqual(["127052"]);
  });

  it("does not suppress distinct QuickBooks identities that share a printed invoice number", () => {
    const candidates = selectAutomaticForwardIntakeCandidates([
      { qboInvoiceId: "qbo-36504", invoiceNumber: "125968", customerName: "Cary Stewart", firstPaymentAt: "2026-08-26T00:00:00.000Z", invoiceDate: "2026-08-26", decision: "AUTO_IMPORT", lines: [] },
      { qboInvoiceId: "qbo-36505", invoiceNumber: "125968", customerName: "Azeem Abbas", firstPaymentAt: "2026-08-26T00:00:00.000Z", invoiceDate: "2026-08-26", decision: "AUTO_IMPORT", lines: [] },
    ]);

    expect(candidates.map((candidate) => candidate.qboInvoiceId)).toEqual(["qbo-36504", "qbo-36505"]);
  });

  it("selects only mapping and identity conflicts for human review", () => {
    const review = selectForwardIntakeReviewCandidates([
      { qboInvoiceId: "represented", invoiceNumber: "127001", customerName: "Ada", firstPaymentAt: "2026-08-26T00:00:00.000Z", invoiceDate: "2026-08-26", decision: "ALREADY_REPRESENTED", lines: [] },
      { qboInvoiceId: "mapping", invoiceNumber: "127002", customerName: "Ben", firstPaymentAt: "2026-08-26T00:00:00.000Z", invoiceDate: "2026-08-26", decision: "MAPPING_REVIEW", lines: [] },
      { qboInvoiceId: "identity", invoiceNumber: "127003", customerName: "Casey", firstPaymentAt: "2026-08-26T00:00:00.000Z", invoiceDate: "2026-08-26", decision: "MANUAL_DUPLICATE_REVIEW", lines: [] },
      { qboInvoiceId: "closed", invoiceNumber: "127004", customerName: "Dee", firstPaymentAt: "2026-08-26T00:00:00.000Z", invoiceDate: "2026-08-26", decision: "CLOSED", lines: [] },
    ]);

    expect(review.map((candidate) => candidate.qboInvoiceId)).toEqual(["mapping", "identity"]);
  });
});
