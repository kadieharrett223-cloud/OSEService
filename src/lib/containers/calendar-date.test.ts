import { afterEach, expect, it } from "vitest";
import { formatCalendarDate } from "./calendar-date";

const originalZone = process.env.TZ;
afterEach(() => { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; });
it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])("preserves saved ETA days in %s", (zone) => {
  process.env.TZ = zone;
  expect(formatCalendarDate("2027-01-27")).toBe("Jan 27");
  expect(formatCalendarDate("2027-01-27", { year: "numeric" })).toBe("Jan 27, 2027");
  expect(formatCalendarDate("2026-03-08")).toBe("Mar 8");
  expect(formatCalendarDate("2026-11-01")).toBe("Nov 1");
  expect(formatCalendarDate("2026-01-01")).toBe("Jan 1");
});
it("keeps real timestamps in Pacific time and rejects invalid calendar days", () => {
  expect(formatCalendarDate("2026-11-16T01:00:00Z")).toBe("Nov 15");
  expect(formatCalendarDate("2026-02-30")).toBe("Pending");
  expect(formatCalendarDate("invalid")).toBe("Pending");
  expect(formatCalendarDate(null, {}, "—")).toBe("—");
});
