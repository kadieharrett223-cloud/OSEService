/** Saved date-only values are calendar days, not midnight instants in Pacific time. */
export function formatCalendarDate(
  value: string | null | undefined,
  options: Intl.DateTimeFormatOptions = {},
  fallback = "Pending",
) {
  if (!value) return fallback;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || (dateOnly && parsed.toISOString().slice(0, 10) !== value)) return fallback;
  return parsed.toLocaleDateString("en-US", {
    month: "short", day: "numeric", ...options,
    timeZone: dateOnly ? "UTC" : "America/Los_Angeles",
  });
}
