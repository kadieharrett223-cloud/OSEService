/**
 * One definition of active customer demand, shared by inventory, containers and orders so the
 * pages cannot disagree.
 *
 * Historical OLD_ERP records were re-created whenever an invoice changed, so the same logical
 * obligation can exist several times. Superseded versions are excluded at import time (their
 * queueStatus is REMOVED/DENIED), which means each surviving row is a distinct obligation and
 * quantities must be SUMMED. Collapsing by invoice with MAX(qty) silently drops real demand.
 */

import { excludeReviewedObligationResolutions, type ReviewedObligationResolution } from "./reviewed-obligation-resolutions";

export const CLOSED_DEMAND_STATES = ["FULFILLED", "SHIPPED", "ARCHIVED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"];

export type DemandLineLike = {
  id: string;
  product_id?: string | null;
  approved_qty?: number | null;
  ordered_qty?: number | null;
  canonical_obligation_qty?: number | null;
  fulfilled_qty?: number | null;
  approval_status?: string | null;
  fulfillment_status?: string | null;
  warehouse_status?: string | null;
  qbo_invoice_line_id?: string | null;
  source_record_id?: string | null;
  logical_demand_key?: string | null;
  parent_duplicate_of_order_id?: string | null;
  parent_cancellation_status?: string | null;
  parent_review_status?: string | null;
  parent_qbo_voided?: boolean;
  parent_source_invoice_id?: string | null;
  parent_source_type?: string | null;
};

export function openQtyOf(line: DemandLineLike) {
  const obligationQty = line.canonical_obligation_qty ?? line.approved_qty ?? 0;
  return Math.max(0, Number(obligationQty) - Number(line.fulfilled_qty ?? 0));
}

/**
 * The one eligibility rule for the Customer List. A real mapped line that has been accepted as
 * operational demand remains in the list until its full ordered obligation is shipped or closed.
 */
export function customerQueueObligationQty(line: DemandLineLike) {
  return Math.max(
    0,
    Number(line.canonical_obligation_qty ?? 0),
    Number(line.approved_qty ?? 0),
    Number(line.ordered_qty ?? 0),
  );
}

export function isOpenCustomerQueueLine(line: DemandLineLike) {
  const approvalStatus = String(line.approval_status ?? "").toUpperCase();
  if (!line.product_id || !["APPROVED", "PARTIAL"].includes(approvalStatus)) return false;
  return isOpenDemandLine({
    ...line,
    canonical_obligation_qty: customerQueueObligationQty(line),
  });
}

/** Uses recorded fulfillment evidence without mutating the historical queue line. */
export function withProvenFulfilledQty<T extends DemandLineLike>(line: T, provenFulfilledQty: number): T {
  return {
    ...line,
    fulfilled_qty: Math.max(0, Number(line.fulfilled_qty ?? 0), Number(provenFulfilledQty ?? 0)),
  };
}

/** Shipment edits record compensating negative events, so fulfillment evidence must be netted. */
export function netRecordedFulfilledQty(events: Array<{ fulfilled_qty: number | null | undefined }>) {
  return Math.max(0, events.reduce((total, event) => total + Number(event.fulfilled_qty ?? 0), 0));
}

/** Shares proven shipment quantity across duplicate representations of one physical obligation. */
export function withLogicalFulfilledQty<T extends DemandLineLike>(lines: T[]): T[] {
  const fulfilledQtyByIdentity = new Map<string, number>();
  for (const line of lines) {
    const identity = demandLineIdentity(line);
    fulfilledQtyByIdentity.set(identity, Math.max(
      fulfilledQtyByIdentity.get(identity) ?? 0,
      Math.max(0, Number(line.fulfilled_qty ?? 0)),
    ));
  }
  return lines.map((line) => withProvenFulfilledQty(line, fulfilledQtyByIdentity.get(demandLineIdentity(line)) ?? 0));
}

/** Customer List demand includes every remaining physical obligation that has not been cancelled, voided, duplicated, or shipped. */
export function isOpenDemandLine(line: DemandLineLike) {
  if (openQtyOf(line) <= 0) return false;
  if (!hasActiveDemandParent(line)) return false;
  return !["FULFILLED", "SHIPPED", "CANCELLED", "REPLACED"].includes(String(line.fulfillment_status ?? "").toUpperCase());
}

/** A retired parent must not contribute fulfillment or demand to its surviving active sibling. */
export function hasActiveDemandParent(line: DemandLineLike) {
  return !line.parent_duplicate_of_order_id
    && String(line.parent_cancellation_status ?? "").toUpperCase() !== "CANCELLED"
    && !line.parent_qbo_voided;
}

/** Keeps a completed QBO order from being resurrected by its bridged OLD_ERP sibling. */
export function excludeCompletedQboSiblings<T extends DemandLineLike>(lines: T[], completedQboLineIds: ReadonlySet<string>) {
  return lines.filter((line) => line.qbo_invoice_line_id || !line.logical_demand_key || !completedQboLineIds.has(line.logical_demand_key));
}

/** A completed QBO invoice has no remaining demand, regardless of the source label on a stale row. */
export function excludeCompletedQboOrderSiblings<T extends DemandLineLike>(lines: T[], completedQboInvoiceIds: ReadonlySet<string>) {
  return lines.filter((line) => !line.parent_source_invoice_id || !completedQboInvoiceIds.has(line.parent_source_invoice_id));
}

/** Applies the one canonical Customer List pipeline used by inventory totals and Customer List rows. */
export function getCanonicalOpenDemandLines<T extends DemandLineLike>(
  lines: T[],
  completedQboLineIds: ReadonlySet<string>,
  completedQboInvoiceIds: ReadonlySet<string>,
  reviewedResolutions: readonly ReviewedObligationResolution[] = [],
) {
  void completedQboLineIds;
  void completedQboInvoiceIds;
  const terminalResolutions = reviewedResolutions.filter((resolution) => ["DUPLICATE", "REPLACED", "HISTORICAL_FULFILLMENT"].includes(resolution.resolution_type));
  const activeParentLines = lines.filter(hasActiveDemandParent);
  const acceptedLiveQuickBooksLines = activeParentLines.filter((line) => (
    line.parent_source_type === "QBO_INVOICE"
    && Boolean(line.qbo_invoice_line_id)
    && isOpenCustomerQueueLine(line)
  ));
  const acceptedLiveIds = new Set(acceptedLiveQuickBooksLines.map((line) => line.id));
  const historicallyResolvedLines = excludeReviewedObligationResolutions(
    activeParentLines.filter((line) => !acceptedLiveIds.has(line.id)),
    terminalResolutions,
  );

  const canonicalCandidates = [...acceptedLiveQuickBooksLines, ...historicallyResolvedLines];
  const canonicalIdentities = new Set(canonicalCandidates.map(demandLineIdentity));
  const rescuedMappedLines = activeParentLines.filter((line) => {
    // A terminal review can correctly suppress a historical line. It must not
    // hide an active mapped customer obligation when the only competing
    // representation of the same QBO line is still unmapped. That is a stale
    // bridge/review artifact, not a cancellation or another sale.
    if (!isOpenCustomerQueueLine(line) || canonicalIdentities.has(demandLineIdentity(line))) return false;
    return activeParentLines.some((candidate) => (
      candidate.id !== line.id
      && demandLineIdentity(candidate) === demandLineIdentity(line)
      && !candidate.product_id
    ));
  });

  // A stale historical resolution may suppress an OLD_ERP representation, but it must never
  // suppress the current mapped line on an active QuickBooks order. QuickBooks is the current
  // invoice truth after a refresh; the local line status and fulfilled quantity decide when that
  // live obligation leaves the Customer List.
  return dedupeDemandLines(withLogicalFulfilledQty([
    ...canonicalCandidates,
    ...rescuedMappedLines,
  ])).filter(isOpenDemandLine);
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
  const byIdentity = new Map<string, T[]>();
  for (const line of lines) {
    const key = demandLineIdentity(line);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), line]);
  }

  return Array.from(byIdentity.values()).map((duplicates) => {
    const selected = [...duplicates].sort((left, right) => {
      // A QBO refresh can create a current sibling that still awaits mapping approval. That
      // unapproved copy is not yet a customer-list obligation and must never hide the prior
      // approved bridged line. Prefer QBO only once it is an open, approved queue line.
      const leftIsLiveQbo = left.parent_source_type === "QBO_INVOICE"
        && Boolean(left.qbo_invoice_line_id)
        && isOpenCustomerQueueLine(left);
      const rightIsLiveQbo = right.parent_source_type === "QBO_INVOICE"
        && Boolean(right.qbo_invoice_line_id)
        && isOpenCustomerQueueLine(right);
      if (leftIsLiveQbo !== rightIsLiveQbo) return leftIsLiveQbo ? -1 : 1;

      // A refresh can leave an unmapped bridge beside the already-approved,
      // product-mapped line for the same physical QBO obligation.  The
      // customer queue is built from the selected representation, so choosing
      // the unmapped copy here makes a real customer disappear from the list.
      // Prefer the mapped operational line; this is a representation choice
      // only and does not create a second obligation or touch inventory.
      const leftIsMapped = Boolean(left.product_id);
      const rightIsMapped = Boolean(right.product_id);
      if (leftIsMapped !== rightIsMapped) return leftIsMapped ? -1 : 1;
      return openQtyOf(right) - openQtyOf(left) || left.id.localeCompare(right.id);
    })[0];
    const warehouseStates = new Set(duplicates.map((line) => String(line.warehouse_status ?? "").toUpperCase()));
    const hasWarehouseState = [...warehouseStates].some((state) => ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(state));
    const hasNonWarehouseState = [...warehouseStates].some((state) => !["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(state));

    // A remapped or accepted duplicate must not inherit a warehouse instruction from its sibling.
    return hasWarehouseState && hasNonWarehouseState
      ? { ...selected, warehouse_status: "APPROVED" } as T
      : selected;
  });
}

export function totalOpenDemand(lines: DemandLineLike[]) {
  return dedupeDemandLines(lines).reduce((sum, line) => sum + openQtyOf(line), 0);
}
