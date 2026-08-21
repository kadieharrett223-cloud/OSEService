/**
 * Order classification for the Orders page.
 *
 * Visibility and "New" are deliberately separate. A dormant bulk import stays hidden until it is
 * activated (its review_status leaves PENDING_REVIEW, which happens when someone enters the
 * invoice) or until reconciliation proved it current by leaving an approved, unfulfilled line.
 */

import { getCanonicalPhysicalOrderSummary, getPhysicalFulfillmentLines, isNonInventoryPhysicalLine, physicalLineOrderedQty } from "./physical-fulfillment";

const CLOSED_LINE_STATES = ["FULFILLED", "CANCELLED", "REMOVED", "DENIED"];
const WAREHOUSE_STATES = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"];

/** Excluded from operational demand pending a data decision. */
const EXCLUDED_ORDER_NUMBERS = ["126037"];

export type ClassificationLine = {
  product_id?: string | null;
  approval_status?: string | null;
  warehouse_status?: string | null;
  fulfillment_status?: string | null;
  ordered_qty?: number | null;
  approved_qty?: number | null;
  fulfilled_qty?: number | null;
  legacy_item_code?: string | null;
  products?: { sku?: string | null; canonical_name?: string | null } | null;
};

export type ClassificationOrder = {
  order_number?: string | null;
  source_type?: string | null;
  review_status?: string | null;
  duplicate_of_order_id?: string | null;
  cancellation_status?: string | null;
  shipping_order_lines?: ClassificationLine[] | null;
  qbo_invoices?: { raw_payload?: ({ PrivateNote?: string | null } & Record<string, unknown>) | null } | null;
};

export type OrderClassification = {
  operationalLines: ClassificationLine[];
  isActivated: boolean;
  isVisibleOperationalOrder: boolean;
  isNewOrder: boolean;
  isWarehouseOrder: boolean;
  isPartiallyShippedOrder: boolean;
  isArchivedOrder: boolean;
  isCancelled: boolean;
};

const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();
const isClosed = (line: ClassificationLine) => CLOSED_LINE_STATES.includes(upper(line.fulfillment_status));

export function classifyOrder(
  order: ClassificationOrder,
  options: { manualMappingSkus?: Set<string> } = {},
): OrderClassification {
  const manualMappingSkus = options.manualMappingSkus ?? new Set<string>();
  const allLines = order.shipping_order_lines ?? [];
  const isExcluded = EXCLUDED_ORDER_NUMBERS.includes(String(order.order_number ?? ""));
  const isVoided = upper(order.qbo_invoices?.raw_payload?.PrivateNote) === "VOIDED";
  const isCancelled = upper(order.cancellation_status) === "CANCELLED";
  const isHistoricalDuplicate = Boolean(order.duplicate_of_order_id);

  if (isCancelled) {
    return {
      operationalLines: [], isActivated: false, isVisibleOperationalOrder: false,
      isNewOrder: false, isWarehouseOrder: false, isPartiallyShippedOrder: false,
      isArchivedOrder: false, isCancelled: true,
    };
  }

  if (isHistoricalDuplicate || isVoided) {
    return {
      operationalLines: [],
      isActivated: false,
      isVisibleOperationalOrder: false,
      isNewOrder: false,
      isWarehouseOrder: false,
      isPartiallyShippedOrder: false,
      isArchivedOrder: false,
      isCancelled: false,
    };
  }

  const canonicalSummary = isExcluded || isVoided
    ? { ordered: 0, fulfilled: 0, remaining: 0, lineCount: 0, items: [], isPartiallyFulfilled: false, isComplete: false }
    : getCanonicalPhysicalOrderSummary({ rawPayload: order.qbo_invoices?.raw_payload, lines: allLines, manualMappingSkus });
  const physicalLines = isExcluded || isVoided ? [] : getPhysicalFulfillmentLines(allLines, { manualMappingSkus });

  const operationalLines = physicalLines.filter((line) => {
    const remaining = Math.max(0, physicalLineOrderedQty(line) - Number(line.fulfilled_qty ?? 0));
    return ["APPROVED", "PARTIAL"].includes(upper(line.approval_status))
      && remaining > 0
      && !isClosed(line);
  });

  const hasUnresolvedLines = allLines.some((line) => !line.product_id && !isNonInventoryPhysicalLine(line) && !isClosed(line))
    || (allLines.length === 0 && order.source_type === "QBO_INVOICE");
  const isActivated = upper(order.review_status) !== "PENDING_REVIEW";

  const hasOperationalLines = operationalLines.length > 0;
  const isVisibleOperationalOrder = (canonicalSummary.remaining > 0 && hasOperationalLines) || (isActivated && hasUnresolvedLines);

  const anyWarehouse = operationalLines.some((line) => WAREHOUSE_STATES.includes(upper(line.warehouse_status)));
  const anyShipped = canonicalSummary.fulfilled > 0 || physicalLines.some((line) => upper(line.fulfillment_status) === "PARTIALLY_FULFILLED");
  const isCompletedServiceOnlyOrder = allLines.length === 0 && upper(order.review_status) === "FULFILLED";

  return {
    operationalLines,
    isActivated,
    isVisibleOperationalOrder,
    isNewOrder: isVisibleOperationalOrder && !anyWarehouse && !anyShipped,
    isWarehouseOrder: hasOperationalLines && anyWarehouse && !anyShipped,
    isPartiallyShippedOrder: anyShipped && canonicalSummary.remaining > 0,
    isArchivedOrder: canonicalSummary.isComplete || isCompletedServiceOnlyOrder,
    isCancelled: false,
  };
}

export function matchesOrderTab(classification: OrderClassification, tabId: string) {
  switch (tabId) {
    case "orders":
      return classification.isVisibleOperationalOrder;
    case "new":
      return classification.isNewOrder;
    case "warehouse":
      return classification.isWarehouseOrder;
    case "partial":
      return classification.isPartiallyShippedOrder;
    case "archived":
      return classification.isArchivedOrder;
    case "cancelled":
      return classification.isCancelled;
    default:
      return true;
  }
}
