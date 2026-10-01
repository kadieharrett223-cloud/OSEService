import { describe, expect, it } from "vitest";
import { authoritativeStockProductIds, canonicalProductSkuKey, canonicalSkuKey, isUnsafeGlobalProductAlias, preferredOperationalSku } from "./canonical-sku";

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

  it("prefers the archived source item code over a stale alias on a recycled numeric SKU", () => {
    expect(preferredOperationalSku("000011", ["HK-4PC-6"], null, "4PML-9")).toBe("4PML-9");
    expect(canonicalProductSkuKey("000011", ["HK-4PC-6"], null, "4PML-9")).toBe("4PML9");
  });

  it("does not let a numeric alias identity add stock to an exact live SKU", () => {
    const keys = new Map([["live-4pc", "4PC6"], ["recycled-id", "4PC6"]]);
    expect(authoritativeStockProductIds([
      { id: "live-4pc", sku: "4PC-6" },
      { id: "recycled-id", sku: "000011" },
    ], keys, new Set(["live-4pc", "recycled-id"]))).toEqual(new Set(["live-4pc"]));
  });

  it("retains a real legacy stock ledger until the current SKU has been explicitly stocked", () => {
    const keys = new Map([["current", "2PCFXL10"], ["legacy", "2PCFXL10"]]);
    expect(authoritativeStockProductIds([
      { id: "current", sku: "2PCFXL-10" },
      { id: "legacy", sku: "HL-2PCFXL-10" },
    ], keys, new Set(["legacy"]))).toEqual(new Set(["legacy"]));
  });

  it("uses an explicit current-SKU zero balance instead of a stale prefixed ledger", () => {
    const keys = new Map([["current", "4PC6"], ["legacy", "4PC6"]]);
    expect(authoritativeStockProductIds([
      { id: "current", sku: "4PC-6" },
      { id: "legacy", sku: "HK-4PC-6" },
    ], keys, new Set(["current", "legacy"]))).toEqual(new Set(["current"]));
  });

  it("never uses generic aliases to merge distinct product models", () => {
    expect(canonicalProductSkuKey("000245", ["220V", "220V3HP", "HPU2203"])).toBe("HPU2203");
    expect(canonicalProductSkuKey("000246", ["220V", "HPU2204"])).toBe("HPU2204");
  });

  it("uses the product's canonical name before incidental historical aliases", () => {
    expect(canonicalProductSkuKey("000012", ["4PHR-9-1", "4PHR-9X"], "HK-4PHR-9X")).toBe("4PHR9X");
  });

  it("rejects accounting labels as reusable product aliases", () => {
    expect(isUnsafeGlobalProductAlias("Note")).toBe(true);
    expect(isUnsafeGlobalProductAlias("Misc Charge")).toBe(true);
    expect(isUnsafeGlobalProductAlias("Shipping")).toBe(true);
    expect(isUnsafeGlobalProductAlias("4PML-9")).toBe(false);
  });
});
