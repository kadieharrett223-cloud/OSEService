import { describe, expect, it } from "vitest";
import { canonicalProductSkuKey, canonicalSkuKey, isUnsafeGlobalProductAlias, preferredOperationalSku } from "./canonical-sku";

describe("canonicalSkuKey", () => {
  it("groups recycled identities under the shared operational SKU", () => {
    expect(canonicalSkuKey("4PC-6")).toBe("4PC6");
    expect(canonicalSkuKey("HK-4PC-6")).toBe("4PC6");
  });

  it("preserves prefix merge exceptions", () => {
    expect(canonicalSkuKey("HL-AR1")).toBe("HLAR1");
  });

  it("uses an operational alias when a recycled product has a numeric primary SKU", () => {
    expect(preferredOperationalSku("000011", ["HK-4PC-6"])).toBe("HK-4PC-6");
    expect(canonicalProductSkuKey("000011", ["HK-4PC-6"])).toBe("4PC6");
  });

  it("never uses generic aliases to merge distinct product models", () => {
    expect(canonicalProductSkuKey("000245", ["220V", "220V3HP", "HPU2203"])).toBe("HPU2203");
    expect(canonicalProductSkuKey("000246", ["220V", "HPU2204"])).toBe("HPU2204");
  });

  it("uses the product's canonical name before incidental historical aliases", () => {
    expect(canonicalProductSkuKey("000012", ["4PHR-9-1", "4PHR-9X"], "HK-4PHR-9X")).toBe("4PHR9X");
  });

  it("uses the model embedded in a descriptive canonical name to merge imported stock and incoming QBO demand", () => {
    expect(canonicalProductSkuKey("000001", ["2PBP-8", "HL-2PBP-8"], "HL-2PBP-8 Base Plate 8K")).toBe("2PBP8");
    expect(canonicalProductSkuKey("2PBP-8", [], "Model: Olympic 2PBP-8 / 8,000-lb Base Plate 2-Post Lift")).toBe("2PBP8");
  });

  it("rejects accounting labels as reusable product aliases", () => {
    expect(isUnsafeGlobalProductAlias("Note")).toBe(true);
    expect(isUnsafeGlobalProductAlias("Misc Charge")).toBe(true);
    expect(isUnsafeGlobalProductAlias("Shipping")).toBe(true);
    expect(isUnsafeGlobalProductAlias("4PML-9")).toBe(false);
  });
});
