/**
 * One definition of active customer demand, shared by inventory, containers and orders so the
 * pages cannot disagree.
 *
 * Historical OLD_ERP records were re-created whenever an invoice changed, so the same logical
 * obligation can exist several times. Superseded versions are excluded at import time (their
 * queueStatus is REMOVED/DENIED), which means each surviving row is a distinct obligation and
 * quantities must be SUMMED. Collapsing by invoice with MAX(qty) silently drops real demand.
 */

export const CLOSED_DEMAND_STATES = ["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"];

export type DemandLineLike = {
  id: string;
  product_id?: string | null;
  approved_qty?: number | null;
  fulfilled_qty?: number | null;
  approval_status?: string | null;
  fulfillment_status?: string | null;
  qbo_invoice_line_id?: string | null;
  source_record_id?: string | null;
};

export function openQtyOf(line: DemandLineLike) {
  return Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
}

/** Open demand is who still needs the product, not everyone who ever ordered it. */
export function isOpenDemandLine(line: DemandLineLike) {
  if (openQtyOf(line) <= 0) return false;
  if (CLOSED_DEMAND_STATES.includes(String(line.approval_status ?? "").toUpperCase())) return false;
  return !CLOSED_DEMAND_STATES.includes(String(line.fulfillment_status ?? "").toUpperCase());
}

/**
 * Identity of the logical obligation behind a line: the QuickBooks invoice line, or the OLD_ERP
 * queue record. Two rows only represent the same obligation when they share one of these.
 */
export function demandLineIdentity(line: DemandLineLike) {
  if (line.qbo_invoice_line_id) return `QBO_LINE:${line.qbo_invoice_line_id}`;
  if (line.source_record_id) return `SOURCE:${line.source_record_id}`;
  return `LINE:${line.id}`;
}

/** Removes repeated imports of one obligation without merging genuinely separate lines. */
export function dedupeDemandLines<T extends DemandLineLike>(lines: T[]): T[] {
  const byIdentity = new Map<string, T>();
  for (const line of lines) {
    const key = demandLineIdentity(line);
    const existing = byIdentity.get(key);
    if (!existing || openQtyOf(line) > openQtyOf(existing)) byIdentity.set(key, line);
  }
  return Array.from(byIdentity.values());
}

export function totalOpenDemand(lines: DemandLineLike[]) {
  return dedupeDemandLines(lines).reduce((sum, line) => sum + openQtyOf(line), 0);
}
