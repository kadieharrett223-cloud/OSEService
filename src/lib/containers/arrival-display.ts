/** Only saved warehouse arrival dates may become customer-facing ETA promises. */
export function savedContainerArrival(container: { eta_confirmed_date: string | null; eta_estimated_date: string | null }) {
  for (const [value, isEstimate] of [[container.eta_confirmed_date, false], [container.eta_estimated_date, true]] as const) {
    if (value && !Number.isNaN(new Date(value).getTime())) return { date: value, isEstimate };
  }
  return { date: null, isEstimate: false };
}

export function containerSummaryUnits(lifecycle: string | null, lines: Array<{ on_order_qty: number | null; received_qty: number | null }>) {
  return lines.reduce((sum, line) => sum + (lifecycle === "RECEIVED"
    ? Math.max(0, Number(line.received_qty ?? 0))
    : Math.max(0, Number(line.on_order_qty ?? 0) - Number(line.received_qty ?? 0))), 0);
}
