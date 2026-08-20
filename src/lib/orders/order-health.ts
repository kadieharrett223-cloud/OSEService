export type HealthSeverity = "INFO" | "WARNING" | "ERROR";

export type OrderHealthIssue = {
  severity: HealthSeverity;
  code: string;
  product: string | null;
  issue: string;
  expected: string;
  actual: string;
  cause: string;
};

export type HealthLine = {
  id: string;
  product_id?: string | null;
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
};

export type HealthShipment = {
  lines?: Array<{ shipping_order_line_id: string; quantity: number | null }>;
};

export type OrderHealthInput = {
  lines: HealthLine[];
  shipments?: HealthShipment[];
  qboLines?: Array<{ qbo_sku?: string | null; ordered_qty?: number | null; product_id?: string | null }>;
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

  if (input.qboVoided && !input.cancelled) {
    issues.push({ severity: "ERROR", code: "VOIDED_ACTIVE", product: null, issue: "QuickBooks invoice is voided but the ERP order is not cancelled", expected: "Cancelled", actual: "Active", cause: "The invoice status changed after import." });
  }
  if (input.cancelled && input.lines.some((line) => remaining(line) > 0)) {
    issues.push({ severity: "WARNING", code: "CANCELLED_OPEN_DEMAND", product: null, issue: "Cancelled order still has remaining demand", expected: "0 remaining demand", actual: String(input.lines.reduce((sum, line) => sum + remaining(line), 0)), cause: "Cancellation has not removed the open obligation from the read model." });
  }

  for (const line of input.lines) {
    const product = productLabel(line);
    const open = remaining(line);
    const shipped = shipmentQtyByLine.get(line.id) ?? 0;
    const status = upper(line.fulfillment_status);
    if (!line.product_id && open > 0) issues.push({ severity: "ERROR", code: "UNMAPPED_PHYSICAL_LINE", product, issue: "Physical demand line has no product mapping", expected: "Mapped product", actual: "Unmapped", cause: "Inventory and shipment actions cannot identify the product." });
    if (line.queue_position_count != null && Number(line.queue_position_count) !== open) issues.push({ severity: "WARNING", code: "QUEUE_COUNT_MISMATCH", product, issue: "Queue range count does not match remaining quantity", expected: String(open), actual: String(line.queue_position_count), cause: "Queue metadata is stale or represents a different logical line." });
    if (open > 0 && line.queue_position_start == null && ["APPROVED", "PARTIAL"].includes(upper(line.approval_status))) issues.push({ severity: "WARNING", code: "QUEUE_POSITION_MISSING", product, issue: "Open approved line has no queue position", expected: "Assigned queue position", actual: "Missing", cause: "The positions-only queue calculation has not assigned this line." });
    const reserved = (line.inventory_allocations ?? []).reduce((sum, allocation) => sum + Number(allocation.quantity ?? 0), 0);
    if (reserved > open && open > 0) issues.push({ severity: "ERROR", code: "RESERVATION_EXCEEDS_DEMAND", product, issue: "Reservation exceeds remaining demand", expected: `<= ${open}`, actual: String(reserved), cause: "Allocation state is ahead of customer-line state." });
    if (reserved > 0 && open <= 0) issues.push({ severity: "ERROR", code: "FULFILLED_RESERVATION", product, issue: "Fulfilled line still has an active reservation", expected: "0 reserved", actual: String(reserved), cause: "Reservation was not released after fulfillment." });
    if (shipped > Number(line.approved_qty ?? line.ordered_qty ?? 0)) issues.push({ severity: "ERROR", code: "SHIPMENT_EXCEEDS_DEMAND", product, issue: "Shipment quantity exceeds ordered demand", expected: `<= ${line.approved_qty ?? line.ordered_qty ?? 0}`, actual: String(shipped), cause: "Shipment history and order-line demand disagree." });
    if (Math.abs(shipped - Number(line.fulfilled_qty ?? 0)) > 0.001) issues.push({ severity: "ERROR", code: "FULFILLMENT_TOTAL_MISMATCH", product, issue: "Fulfilled quantity does not equal shipment history", expected: String(line.fulfilled_qty ?? 0), actual: String(shipped), cause: "A shipment or fulfillment record is missing or duplicated." });
    if (status === "FULFILLED" && open > 0) issues.push({ severity: "ERROR", code: "FULFILLED_WITH_OPEN_DEMAND", product, issue: "Line is marked fulfilled but still has remaining demand", expected: "0 remaining", actual: String(open), cause: "Fulfillment status and quantities disagree." });
  }

  return issues;
}
