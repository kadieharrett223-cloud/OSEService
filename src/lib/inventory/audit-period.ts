const zone = "America/Los_Angeles";
const parts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map((part) => [part.type, part.value]));

function midnight(year: number, month: number, day: number) {
  const target = Date.UTC(year, month - 1, day);
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(candidate));
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    candidate += target - represented;
  }
  return new Date(candidate).toISOString();
}

export function inventoryAuditPeriod(value: string | undefined, now = new Date()) {
  const period = value === "week" || value === "month" ? value : "all";
  const p = parts(now);
  const calendar = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  if (period === "week") calendar.setUTCDate(calendar.getUTCDate() - (calendar.getUTCDay() + 6) % 7);
  if (period === "month") calendar.setUTCDate(1);
  return {
    period,
    label: period === "week" ? "This week (Monday–today)" : period === "month" ? "This month" : "All history",
    start: period === "all" ? null : midnight(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate()),
    end: now.toISOString(),
  };
}
