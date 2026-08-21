/**
 * Order classification for the Orders page.
 *
 * Visibility and "New" are deliberately separate. A dormant bulk import stays hidden until it is
 * activated (its review_status leaves PENDING_REVIEW, which happens when someone enters the
 * invoice) or until reconciliation proved it current by leaving an approved, unfulfilled line.
 */

const CLOSED_LINE_STATES = ["FULFILLED", "CANCELLED", "REMOVED", "DENIED"];
const WAREHOUSE_STATES = ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"];
const NON_INVENTORY_TEXT = /discount|shipping|freight|sales tax|tax adjustment|\bnote\b|\bservice\b|\binstall(?:ation)?\b/i;

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
  qbo_invoices?: { raw_payload?: { PrivateNote?: string | null } | null } | null;
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

function isNonInventoryLine(line: ClassificationLine) {
  const text = [line.legacy_item_code, line.products?.sku, line.products?.canonical_name].filter(Boolean).join(" ");
  return NON_INVENTORY_TEXT.test(text);
}

function remainingOf(line: ClassificationLine) {
  const approved = Number(line.approved_qty ?? 0);
  const basis = approved > 0 ? approved : Number(line.ordered_qty ?? 0);
  return basis - Number(line.fulfilled_qty ?? 0);
}

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

  const physicalLines = allLines.filter((line) => {
    return Boolean(line.product_id)
      && !isExcluded
      && !isVoided
      && !manualMappingSkus.has(upper(line.products?.sku))
      && !manualMappingSkus.has(upper(line.legacy_item_code))
      && !isNonInventoryLine(line)
      && !["CANCELLED", "REMOVED", "DENIED"].includes(upper(line.fulfillment_status));
  });
  const physicalOrderedTotal = physicalLines.reduce((sum, line) => sum + Math.max(Number(line.approved_qty ?? 0), Number(line.ordered_qty ?? 0)), 0);
  const physicalFulfilledTotal = physicalLines.reduce((sum, line) => sum + Math.min(
    Math.max(Number(line.approved_qty ?? 0), Number(line.ordered_qty ?? 0)),
    Math.max(0, Number(line.fulfilled_qty ?? 0)),
  ), 0);
  const physicalRemainingTotal = Math.max(0, physicalOrderedTotal - physicalFulfilledTotal);

  const operationalLines = physicalLines.filter((line) => {
    const remaining = Math.max(0, Number(line.approved_qty ?? line.ordered_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
    return ["APPROVED", "PARTIAL"].includes(upper(line.approval_status))
      && remaining > 0
      && !isClosed(line);
  });

  const hasUnresolvedLines = allLines.some((line) => !line.product_id && !isNonInventoryLine(line) && !isClosed(line))
    || (allLines.length === 0 && order.source_type === "QBO_INVOICE");
  const isActivated = upper(order.review_status) !== "PENDING_REVIEW";

  const hasOperationalLines = operationalLines.length > 0;
  const isVisibleOperationalOrder = (physicalRemainingTotal > 0 && hasOperationalLines) || (isActivated && hasUnresolvedLines);

  const anyWarehouse = operationalLines.some((line) => WAREHOUSE_STATES.includes(upper(line.warehouse_status)));
  const anyShipped = physicalFulfilledTotal > 0 || physicalLines.some((line) => upper(line.fulfillment_status) === "PARTIALLY_FULFILLED");
  const isCompletedServiceOnlyOrder = allLines.length === 0 && upper(order.review_status) === "FULFILLED";

  return {
    operationalLines,
    isActivated,
    isVisibleOperationalOrder,
    isNewOrder: isVisibleOperationalOrder && !anyWarehouse && !anyShipped,
    isWarehouseOrder: hasOperationalLines && anyWarehouse && !anyShipped,
    isPartiallyShippedOrder: anyShipped && physicalRemainingTotal > 0,
    isArchivedOrder: (physicalOrderedTotal > 0 && physicalRemainingTotal === 0) || isCompletedServiceOnlyOrder,
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
