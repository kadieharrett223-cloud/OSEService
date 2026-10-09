import { describe, expect, it } from "vitest";
import { inventoryAuditPeriod } from "./audit-period";
describe("inventory audit date filters", () => {
  it("starts the week on Monday in Pacific time", () => {
    expect(inventoryAuditPeriod("week", new Date("2026-10-09T20:00:00Z")).start).toBe("2026-10-05T07:00:00.000Z");
  });
  it("starts the month at Pacific midnight", () => {
    expect(inventoryAuditPeriod("month", new Date("2026-10-09T20:00:00Z")).start).toBe("2026-10-01T07:00:00.000Z");
  });
  it("uses the local date rather than the UTC date at a month boundary", () => {
    expect(inventoryAuditPeriod("month", new Date("2026-11-01T02:00:00Z")).start).toBe("2026-10-01T07:00:00.000Z");
  });
  it("handles winter offsets and DST transition weeks", () => {
    expect(inventoryAuditPeriod("month", new Date("2026-12-10T20:00:00Z")).start).toBe("2026-12-01T08:00:00.000Z");
    expect(inventoryAuditPeriod("week", new Date("2026-03-08T20:00:00Z")).start).toBe("2026-03-02T08:00:00.000Z");
  });
  it("preserves all history by default", () => {
    expect(inventoryAuditPeriod("invalid").start).toBeNull();
  });
});
