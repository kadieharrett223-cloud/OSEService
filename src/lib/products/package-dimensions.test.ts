import { describe, expect, it } from "vitest";
import { formatPackageDimensions, formatPackageWeight, getPackageDimensions } from "./package-dimensions";

describe("package dimensions", () => {
  it("reads packaged inches and pounds from a preserved product source payload", () => {
    const dimensions = getPackageDimensions({ lengthInches: 112, widthInches: "18", heightInches: 37.92, weightLbs: 1400 });
    expect(dimensions).toEqual({ lengthInches: 112, widthInches: 18, heightInches: 37.92, weightPounds: 1400 });
    expect(formatPackageDimensions(dimensions!)).toBe("112 × 18 × 37.92 in");
    expect(formatPackageWeight(dimensions!)).toBe("1,400 lb");
  });

  it("keeps a valid weight when package dimensions are incomplete", () => {
    const weightOnly = getPackageDimensions({ lengthInches: 112, widthInches: 0, heightInches: 38, weightLbs: 1595 });
    expect(weightOnly).toEqual({ lengthInches: 112, widthInches: null, heightInches: 38, weightPounds: 1595 });
    expect(formatPackageDimensions(weightOnly!)).toBeNull();
    expect(formatPackageWeight(weightOnly!)).toBe("1,595 lb");
    expect(getPackageDimensions({ lengthInches: 112, widthInches: 18, heightInches: 38, weightLbs: 0 })?.weightPounds).toBeNull();
  });
});