import { describe, expect, it } from "vitest";
import { classifyQboForwardIntakeLine, isInventoryDemandQuickbooksLine } from "./qbo-forward-intake";

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
});
