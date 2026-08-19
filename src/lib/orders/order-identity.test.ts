import { describe, expect, it } from "vitest";
import { hasLogicalOrderForInvoice, resolveCanonicalOrderParent } from "./order-identity";

describe("logical order identity", () => {
  it("reuses an OLD_ERP parent when the same QBO invoice is later imported", () => {
    const existing = [{ id: "old-order", source_type: "INTERNAL", source_system: "OLD_ERP", created_at: "2026-08-12" }];
    expect(hasLogicalOrderForInvoice(existing)).toBe(true);
    expect(resolveCanonicalOrderParent(existing)?.id).toBe("old-order");
  });

  it("prefers an existing QBO parent over an older OLD_ERP parent", () => {
    const existing = [
      { id: "old-order", source_type: "INTERNAL", source_system: "OLD_ERP", created_at: "2026-08-12" },
      { id: "qbo-order", source_type: "QBO_INVOICE", source_system: null, created_at: "2026-08-13" },
    ];
    expect(resolveCanonicalOrderParent(existing)?.id).toBe("qbo-order");
  });

  it("does not treat provenance as separate invoice identity", () => {
    const existing = [
      { id: "old-order", source_type: "INTERNAL", source_system: "OLD_ERP" },
      { id: "qbo-order", source_type: "QBO_INVOICE", source_system: null },
    ];
    expect(hasLogicalOrderForInvoice(existing)).toBe(true);
  });
});
