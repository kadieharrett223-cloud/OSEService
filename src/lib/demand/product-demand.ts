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
  warehouse_status?: string | null;
  qbo_invoice_line_id?: string | null;
  source_record_id?: string | null;
  logical_demand_key?: string | null;
  parent_duplicate_of_order_id?: string | null;
  parent_cancellation_status?: string | null;
  parent_qbo_voided?: boolean;
};

export function openQtyOf(line: DemandLineLike) {
  return Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
}

/** Open demand is who still needs the product, not everyone who ever ordered it. */
export function isOpenDemandLine(line: DemandLineLike) {
  if (openQtyOf(line) <= 0) return false;
  if (line.parent_duplicate_of_order_id || String(line.parent_cancellation_status ?? "").toUpperCase() === "CANCELLED" || line.parent_qbo_voided) return false;
  if (CLOSED_DEMAND_STATES.includes(String(line.approval_status ?? "").toUpperCase())) return false;
  return !CLOSED_DEMAND_STATES.includes(String(line.fulfillment_status ?? "").toUpperCase());
}

/** Keeps a completed QBO order from being resurrected by its bridged OLD_ERP sibling. */
export function excludeCompletedQboSiblings<T extends DemandLineLike>(lines: T[], completedQboLineIds: ReadonlySet<string>) {
  return lines.filter((line) => line.qbo_invoice_line_id || !line.logical_demand_key || !completedQboLineIds.has(line.logical_demand_key));
}

/**
 * Identity of the logical obligation behind a line: the QuickBooks invoice line, or the OLD_ERP
 * queue record. Two rows only represent the same obligation when they share one of these.
 */
export function demandLineIdentity(line: DemandLineLike) {
  if (line.qbo_invoice_line_id) return `QBO_LINE:${line.qbo_invoice_line_id}`;
  if (line.logical_demand_key) return `QBO_LINE:${line.logical_demand_key}`;
  if (line.source_record_id) return `SOURCE:${line.source_record_id}`;
  return `LINE:${line.id}`;
}

/** Removes repeated imports of one obligation without merging genuinely separate lines. */
export function dedupeDemandLines<T extends DemandLineLike>(lines: T[]): T[] {
  const byIdentity = new Map<string, T>();
  for (const line of lines) {
    const key = demandLineIdentity(line);
    const existing = byIdentity.get(key);
    const lineIsReserved = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String((line as DemandLineLike & { warehouse_status?: string | null }).warehouse_status ?? "").toUpperCase());
    const existingIsReserved = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String((existing as (DemandLineLike & { warehouse_status?: string | null }) | undefined)?.warehouse_status ?? "").toUpperCase());
    if (!existing || openQtyOf(line) > openQtyOf(existing) || (openQtyOf(line) === openQtyOf(existing) && lineIsReserved && !existingIsReserved)) byIdentity.set(key, line);
  }
  return Array.from(byIdentity.values());
}

export function totalOpenDemand(lines: DemandLineLike[]) {
  return dedupeDemandLines(lines).reduce((sum, line) => sum + openQtyOf(line), 0);
}
