import { getCanonicalPhysicalOrderSummary, getPhysicalFulfillmentTotals } from "./physical-fulfillment";

export type HealthSeverity = "INFO" | "WARNING" | "ERROR";

export type OrderHealthIssue = {
  severity: HealthSeverity;
  code: string;
  lineId?: string;
  warehouseStatus?: string | null;
  product: string | null;
  issue: string;
  expected: string;
  actual: string;
  cause: string;
};

export type HealthLine = {
  id: string;
  product_id?: string | null;
  legacy_item_code?: string | null;
  ordered_qty?: number | null;
  approved_qty?: number | null;
  fulfilled_qty?: number | null;
  approval_status?: string | null;
  fulfillment_status?: string | null;
  warehouse_status?: string | null;
  queue_position_start?: number | null;
  queue_position_count?: number | null;
  products?: { sku?: string | null; canonical_name?: string | null } | null;
  inventory_allocations?: Array<{ quantity?: number | null; source_type?: string | null }>;
  fulfillment_source?: string | null;
  fulfillment_supplier?: string | null;
  fulfillment_notes?: string | null;
};

export type HealthShipment = {
  lines?: Array<{ shipping_order_line_id: string; quantity: number | null }>;
};

export type HealthFulfillmentEvidence = {
  shipping_order_line_id: string;
  fulfilled_qty: number | null;
  fulfillment_type?: string | null;
};

export type OrderHealthInput = {
  lines: HealthLine[];
  shipments?: HealthShipment[];
  fulfillments?: HealthFulfillmentEvidence[];
  qboLines?: Array<{ qbo_sku?: string | null; ordered_qty?: number | null; product_id?: string | null }>;
  qboRawPayload?: unknown;
  qboVoided?: boolean;
  cancelled?: boolean;
};

const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();
const productLabel = (line: HealthLine) => line.products?.sku ?? line.products?.canonical_name ?? line.product_id ?? "Unknown product";
const remaining = (line: HealthLine) => Math.max(0, Number(line.approved_qty ?? line.ordered_qty ?? 0) - Number(line.fulfilled_qty ?? 0));

export function evaluateOrderHealth(input: OrderHealthInput): OrderHealthIssue[] {
  const issues: OrderHealthIssue[] = [];
  const shipmentQtyByLine = new Map<string, number>();
  for (const shipment of input.shipments ?? []) {
    for (const line of shipment.lines ?? []) shipmentQtyByLine.set(line.shipping_order_line_id, (shipmentQtyByLine.get(line.shipping_order_line_id) ?? 0) + Number(line.quantity ?? 0));
  }
  const fulfillmentEvidenceQtyByLine = new Map(shipmentQtyByLine);
  for (const fulfillment of input.fulfillments ?? []) {
    const type = upper(fulfillment.fulfillment_type);
    if (!["PICKUP", "DROPSHIP", "OTHER"].includes(type)) continue;
    fulfillmentEvidenceQtyByLine.set(fulfillment.shipping_order_line_id, (fulfillmentEvidenceQtyByLine.get(fulfillment.shipping_order_line_id) ?? 0) + Number(fulfillment.fulfilled_qty ?? 0));
  }

  if (input.qboVoided && !input.cancelled) {
    issues.push({ severity: "ERROR", code: "VOIDED_ACTIVE", product: null, issue: "QuickBooks invoice is voided but the ERP order is not cancelled", expected: "Cancelled", actual: "Active", cause: "The invoice status changed after import." });
  }

  const canonicalSummary = getCanonicalPhysicalOrderSummary({ rawPayload: input.qboRawPayload, lines: input.lines });
  const rawPhysicalTotals = getPhysicalFulfillmentTotals(input.lines);
  if (canonicalSummary.ordered !== rawPhysicalTotals.ordered || canonicalSummary.fulfilled !== rawPhysicalTotals.fulfilled) {
    issues.push({
      severity: "WARNING",
      code: "ORDER_SUMMARY_MISMATCH",
      product: null,
      issue: "Raw operational rows disagree with canonical physical order summary",
      expected: `${canonicalSummary.lineCount} items / ${canonicalSummary.ordered} ordered / ${canonicalSummary.fulfilled} fulfilled / ${canonicalSummary.remaining} remaining`,
      actual: `${rawPhysicalTotals.lineCount} rows / ${rawPhysicalTotals.ordered} ordered / ${rawPhysicalTotals.fulfilled} fulfilled / ${rawPhysicalTotals.remaining} remaining`,
      cause: "Duplicate, orphan, or non-applicable operational rows would display different customer-facing quantities without canonical dedupe.",
    });
  }

  for (const line of input.lines) {
    const product = productLabel(line);
    const open = remaining(line);
    const shipped = shipmentQtyByLine.get(line.id) ?? 0;
    const fulfilledEvidence = fulfillmentEvidenceQtyByLine.get(line.id) ?? 0;
    const status = upper(line.fulfillment_status);
    const context = { lineId: line.id, warehouseStatus: line.warehouse_status };
    if (upper(line.fulfillment_source) === "DROPSHIP" && !line.fulfillment_supplier) issues.push({ ...context, severity: "WARNING", code: "DROPSHIP_SUPPLIER_MISSING", product, issue: "Dropship source has no supplier detail", expected: "Supplier/vendor", actual: "Missing", cause: "Add the supplier before relying on this fulfillment source." });
    if (upper(line.fulfillment_source) === "OTHER" && !line.fulfillment_notes) issues.push({ ...context, severity: "WARNING", code: "OTHER_SOURCE_NOTE_MISSING", product, issue: "Other fulfillment source has no note", expected: "Source note", actual: "Missing", cause: "Explain how this line will be fulfilled." });
    if (upper(line.fulfillment_source) === "WAREHOUSE" && !line.product_id) issues.push({ ...context, severity: "ERROR", code: "WAREHOUSE_SOURCE_UNMAPPED", product, issue: "Warehouse source has no product mapping", expected: "Mapped product", actual: "Unmapped", cause: "Warehouse fulfillment cannot identify physical inventory." });
    if (!line.product_id && open > 0) issues.push({ ...context, severity: "ERROR", code: "UNMAPPED_PHYSICAL_LINE", product, issue: "Physical demand line has no product mapping", expected: "Mapped product", actual: "Unmapped", cause: "Inventory and shipment actions cannot identify the product." });
    if (line.queue_position_count != null && Number(line.queue_position_count) !== open) issues.push({ ...context, severity: "WARNING", code: "QUEUE_COUNT_MISMATCH", product, issue: "Queue range count does not match remaining quantity", expected: String(open), actual: String(line.queue_position_count), cause: "Queue metadata is stale or represents a different logical line." });
    if (open > 0 && line.queue_position_start == null && ["APPROVED", "PARTIAL"].includes(upper(line.approval_status))) issues.push({ ...context, severity: "WARNING", code: "QUEUE_POSITION_MISSING", product, issue: "Open approved line has no queue position", expected: "Assigned queue position", actual: "Missing", cause: "The positions-only queue calculation has not assigned this line." });
    const reserved = (line.inventory_allocations ?? []).reduce((sum, allocation) => sum + Number(allocation.quantity ?? 0), 0);
    if (reserved > open && open > 0) issues.push({ ...context, severity: "ERROR", code: "RESERVATION_EXCEEDS_DEMAND", product, issue: "Reservation exceeds remaining demand", expected: `<= ${open}`, actual: String(reserved), cause: "Allocation state is ahead of customer-line state." });
    if (reserved > 0 && open <= 0) issues.push({ ...context, severity: "ERROR", code: "FULFILLED_RESERVATION", product, issue: "Fulfilled line still has an active reservation", expected: "0 reserved", actual: String(reserved), cause: "Reservation was not released after fulfillment." });
    if (shipped > Number(line.approved_qty ?? line.ordered_qty ?? 0)) issues.push({ ...context, severity: "ERROR", code: "SHIPMENT_EXCEEDS_DEMAND", product, issue: "Shipment quantity exceeds ordered demand", expected: `<= ${line.approved_qty ?? line.ordered_qty ?? 0}`, actual: String(shipped), cause: "Shipment history and order-line demand disagree." });
    if (Math.abs(fulfilledEvidence - Number(line.fulfilled_qty ?? 0)) > 0.001) issues.push({ ...context, severity: "ERROR", code: "FULFILLMENT_TOTAL_MISMATCH", product, issue: "Fulfilled quantity does not equal fulfillment evidence", expected: String(line.fulfilled_qty ?? 0), actual: String(fulfilledEvidence), cause: "A shipment, pickup, dropship, or manual fulfillment record is missing or duplicated." });
    if (status === "FULFILLED" && open > 0) issues.push({ ...context, severity: "ERROR", code: "FULFILLED_WITH_OPEN_DEMAND", product, issue: "Line is marked fulfilled but still has remaining demand", expected: "0 remaining", actual: String(open), cause: "Fulfillment status and quantities disagree." });
  }

  return issues;
}
