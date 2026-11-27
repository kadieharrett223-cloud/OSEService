import { describe, expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
import { getShippingPackageSpecification as spec } from "./shipping-package-specifications";
import { formatPackageDimensions, formatPackageWeight } from "./package-dimensions";
import { applyShippingPackageSpecifications } from "./package-dimensions-data";

describe("Kadie's approved shipping specifications", () => {
  it("replaces obsolete dimensions/weights consistently for prefixed and numeric-source products", () => {
    const legacy = { "4PHR9X": { lengthInches: 185, widthInches: 21, heightInches: 29, weightPounds: 1715 } };
    const inventory = applyShippingPackageSpecifications(legacy);
    expect(inventory["4PHR9X"]).toEqual(spec("HK-4PHR-9X"));
    expect(inventory["4PHR9X"].weightPounds).toBe(1995);
    expect(legacy["4PHR9X"].weightPounds).toBe(1715);
    expect(spec("4PC-6")).toMatchObject({ lengthInches: 154, weightPounds: 1215 });
    expect(spec("4PHDXL-12")?.weightPounds).toBe(2980);
    expect(spec("4PHDXLA-12")?.weightPounds).toBe(3285);
  });
  it("counts the 2PCFHD-15 crate within the approved total exactly once", () => {
    const value = spec("2PCFHD-15")!;
    expect(value.weightPounds).toBe(2215);
    expect(value.packages?.reduce((total, piece) => total + (piece.totalWeightPounds ?? 0), 0)).toBe(2215);
    expect(value.packages?.[1]).toMatchObject({ lengthInches: 18, widthInches: 27, heightInches: 15, totalWeightPounds: 190 });
  });
  it("retains both stacker bundles without merging an ambiguous separate identity", () => {
    expect(spec("4032XL")?.packages).toHaveLength(2);
    expect(spec("4032XL")?.weightPounds).toBe(5380);
    expect(formatPackageDimensions(spec("4032XL")!)).toContain("192 × 23 × 28 in");
    expect(spec("4P-4032XL")).toBeNull();
  });
  it("uses combined support-crate weight for AS800 and all three T-999E crates", () => {
    const alignment = spec("AS800")!;
    expect(alignment.packages?.reduce((total, piece) => total + piece.quantity, 0)).toBe(3);
    expect(alignment.packages?.[1]).toMatchObject({ quantity: 2, totalWeightPounds: 260 });
    expect(alignment.weightPounds).toBe(710);
    expect(formatPackageDimensions(alignment)).toContain("260 lb combined");
    expect(spec("T-999E")?.weightPounds).toBe(1075);
    expect(spec("T-999E")?.packages).toHaveLength(3);
    expect(formatPackageWeight(spec("T-999E")!)).toBe("1,075 lb total");
  });
  it("preserves missing weights and does not invent values for blank catalog entries", () => {
    expect(spec("HDML-1")).toMatchObject({ lengthInches: 79, widthInches: 28, heightInches: 10, weightPounds: null });
    expect(spec("JVCJ-6")?.weightPounds).toBeNull();
    expect(spec("HDMBL-8")).toBeNull();
    expect(spec("4032-4")).toBeNull();
  });
});
