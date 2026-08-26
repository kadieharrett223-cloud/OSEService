import { describe, expect, it } from "vitest";
import { classifyQboBacklogLine } from "./qbo-backlog-classifier";

describe("QBO backlog classifier", () => {
  it("imports an eligible mapped line with no identity or similarity conflict", () => {
    expect(classifyQboBacklogLine({
      hasExactExistingLine: false,
      hasTerminalOrReviewedResolution: false,
      hasMappedProduct: true,
      hasPossibleManualDuplicate: false,
    })).toBe("IMPORTED");
  });

  it("skips an exact existing line even when it resembles a manually entered order", () => {
    expect(classifyQboBacklogLine({
      hasExactExistingLine: true,
      hasTerminalOrReviewedResolution: false,
      hasMappedProduct: true,
      hasPossibleManualDuplicate: true,
    })).toBe("ALREADY PRESENT — SKIPPED");
  });

  it("keeps reviewed or terminal obligations closed", () => {
    expect(classifyQboBacklogLine({
      hasExactExistingLine: false,
      hasTerminalOrReviewedResolution: true,
      hasMappedProduct: true,
      hasPossibleManualDuplicate: false,
    })).toBe("CLOSED — SKIPPED");
  });

  it("quarantines an unmapped physical line without choosing a product", () => {
    expect(classifyQboBacklogLine({
      hasExactExistingLine: false,
      hasTerminalOrReviewedResolution: false,
      hasMappedProduct: false,
      hasPossibleManualDuplicate: false,
    })).toBe("UNMAPPED — REVIEW");
  });

  it("quarantines a similarity-only manual match rather than adding demand", () => {
    expect(classifyQboBacklogLine({
      hasExactExistingLine: false,
      hasTerminalOrReviewedResolution: false,
      hasMappedProduct: true,
      hasPossibleManualDuplicate: true,
    })).toBe("MANUAL DUPLICATE — REVIEW");
  });
});