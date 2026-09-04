import { describe, expect, it } from "vitest";
import { canonicalProductSkuKey, canonicalSkuKey, preferredOperationalSku } from "./canonical-sku";

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
});