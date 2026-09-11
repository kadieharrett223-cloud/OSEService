import { describe, expect, it } from "vitest";
import { isWithinAutomaticQboIntake } from "./qbo-intake-policy";

describe("isWithinAutomaticQboIntake", () => {
  it("uses the shared June reconciliation boundary", () => {
    expect(isWithinAutomaticQboIntake("2026-05-31T23:59:59.999Z")).toBe(false);
    expect(isWithinAutomaticQboIntake("2026-06-01T00:00:00.000Z")).toBe(true);
    expect(isWithinAutomaticQboIntake("2026-09-11T12:00:00.000Z")).toBe(true);
  });

  it("rejects missing or invalid payment evidence", () => {
    expect(isWithinAutomaticQboIntake(null)).toBe(false);
    expect(isWithinAutomaticQboIntake("not-a-date")).toBe(false);
  });
});
