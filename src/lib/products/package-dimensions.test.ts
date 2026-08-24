import { describe, expect, it } from "vitest";
import { formatPackageDimensions, formatPackageWeight, getPackageDimensions } from "./package-dimensions";

describe("package dimensions", () => {
  it("reads packaged inches and pounds from a preserved product source payload", () => {
    const dimensions = getPackageDimensions({ lengthInches: 112, widthInches: "18", heightInches: 37.92, weightLbs: 1400 });
    expect(dimensions).toEqual({ lengthInches: 112, widthInches: 18, heightInches: 37.92, weightPounds: 1400 });
    expect(formatPackageDimensions(dimensions!)).toBe("112 × 18 × 37.92 in");
    expect(formatPackageWeight(dimensions!)).toBe("1,400 lb");
  });

  it("does not treat partial or non-positive measurements as a package", () => {
    expect(getPackageDimensions({ lengthInches: 112, widthInches: 0, heightInches: 38, weightLbs: 1595 })).toBeNull();
    expect(getPackageDimensions({ lengthInches: 112, widthInches: 18, heightInches: 38, weightLbs: 0 })?.weightPounds).toBeNull();
  });
});