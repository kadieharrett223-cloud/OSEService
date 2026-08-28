import { canonicalSkuKey } from "@/lib/products/canonical-sku";
import { qboSkuCandidates } from "./quickbooks-refresh";

const NON_INVENTORY_TEXT = /discount|shipping|freight|delivery|sales tax|tax adjustment|\bnote\b|\bservice\b|\binstall(?:ation)?\b/i;
const EXCLUDED_PHYSICAL_STATES = new Set(["CANCELLED", "REMOVED", "DENIED"]);

export type PhysicalFulfillmentLine = {
  id?: string | null;
  product_id?: string | null;
  qbo_invoice_line_id?: string | null;
  approval_status?: string | null;
  warehouse_status?: string | null;
  fulfillment_status?: string | null;
  fulfillment_source?: string | null;
  queue_position_start?: number | null;
  queue_position_count?: number | null;
  ordered_qty?: number | null;
  approved_qty?: number | null;
  fulfilled_qty?: number | null;
  legacy_item_code?: string | null;
  products?: { sku?: string | null; canonical_name?: string | null } | null;
};

export type PhysicalFulfillmentTotals = {
  ordered: number;
  fulfilled: number;
  remaining: number;
  lineCount: number;
};

export type CanonicalPhysicalLineItem = {
  key: string;
  sku: string | null;
  quantity: number;
  fulfilled: number;
  remaining: number;
  line: PhysicalFulfillmentLine | null;
};

export type CanonicalPhysicalOrderSummary = PhysicalFulfillmentTotals & {
  items: CanonicalPhysicalLineItem[];
  isPartiallyFulfilled: boolean;
  isComplete: boolean;
};

const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();

export function isNonInventoryPhysicalLine(line: PhysicalFulfillmentLine) {
  const text = [
    line.legacy_item_code,
    line.products?.sku,
    line.products?.canonical_name,
  ].filter(Boolean).join(" ");
  return NON_INVENTORY_TEXT.test(text);
}

export function physicalLineOrderedQty(line: PhysicalFulfillmentLine) {
  return Math.max(Number(line.approved_qty ?? 0), Number(line.ordered_qty ?? 0));
}

export function isPhysicalFulfillmentLine(
  line: PhysicalFulfillmentLine,
  options: { manualMappingSkus?: Set<string> } = {},
) {
  const manualMappingSkus = options.manualMappingSkus ?? new Set<string>();
  return Boolean(line.product_id)
    && !manualMappingSkus.has(upper(line.products?.sku))
    && !manualMappingSkus.has(upper(line.legacy_item_code))
    && !isNonInventoryPhysicalLine(line)
    && !EXCLUDED_PHYSICAL_STATES.has(upper(line.fulfillment_status));
}

export function isRemainingPhysicalFulfillmentLine(
  line: PhysicalFulfillmentLine,
  options: { manualMappingSkus?: Set<string> } = {},
) {
  return isPhysicalFulfillmentLine(line, options)
    && physicalLineOrderedQty(line) > Math.max(0, Number(line.fulfilled_qty ?? 0));
}

export function getPhysicalFulfillmentLines(
  lines: PhysicalFulfillmentLine[] | null | undefined,
  options: { manualMappingSkus?: Set<string> } = {},
) {
  return (lines ?? []).filter((line) => isPhysicalFulfillmentLine(line, options));
}

export function getPhysicalFulfillmentTotals(
  lines: PhysicalFulfillmentLine[] | null | undefined,
  options: { manualMappingSkus?: Set<string> } = {},
): PhysicalFulfillmentTotals {
  const physicalLines = getPhysicalFulfillmentLines(lines, options);
  const ordered = physicalLines.reduce((sum, line) => sum + physicalLineOrderedQty(line), 0);
  const fulfilled = physicalLines.reduce((sum, line) => {
    const basis = physicalLineOrderedQty(line);
    return sum + Math.min(basis, Math.max(0, Number(line.fulfilled_qty ?? 0)));
  }, 0);

  return {
    ordered,
    fulfilled,
    remaining: Math.max(0, ordered - fulfilled),
    lineCount: physicalLines.length,
  };
}

function parseInvoicePhysicalItems(rawPayload: unknown) {
  const lines = Array.isArray((rawPayload as { Line?: unknown[] } | null | undefined)?.Line)
    ? (rawPayload as { Line: unknown[] }).Line
    : [];

  return lines.map((line, index) => {
    if (!line || typeof line !== "object") return null;
    const item = line as { Id?: unknown; DetailType?: unknown; Description?: unknown; Qty?: unknown; SalesItemLineDetail?: { Qty?: unknown; ItemRef?: { name?: unknown } } };
    const sku = typeof item.SalesItemLineDetail?.ItemRef?.name === "string" ? item.SalesItemLineDetail.ItemRef.name.trim() : null;
    const description = typeof item.Description === "string" ? item.Description.trim() : "";
    const detailType = typeof item.DetailType === "string" ? item.DetailType : "";
    if (!sku && !description && detailType !== "SalesItemLineDetail") return null;
    const text = `${sku ?? ""} ${description}`;
    const isNonInventory = detailType !== "SalesItemLineDetail"
      || description.startsWith("--")
      || String(sku ?? "").trim().toLowerCase() === "note"
      || String(sku ?? "").trim().toLowerCase().startsWith("note:")
      || NON_INVENTORY_TEXT.test(text);
    const detailQtyRaw = item.SalesItemLineDetail?.Qty;
    const topLevelQtyRaw = item.Qty;
    const hasExplicitQty = detailQtyRaw !== undefined || topLevelQtyRaw !== undefined;
    const qty = Number(detailQtyRaw ?? topLevelQtyRaw ?? Number.NaN);
    if (isNonInventory) return null;
    if (hasExplicitQty && Number.isFinite(qty) && qty <= 0) return null;
    return {
      key: String(item.Id ?? `${sku ?? "invoice-line"}-${index}`),
      sku,
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
    };
  }).filter((item): item is { key: string; sku: string | null; quantity: number } => Boolean(item && item.quantity > 0));
}

export function matchesPhysicalLineToInvoiceSku(line: PhysicalFulfillmentLine, invoiceSku: string | null) {
  const invoiceKeys = qboSkuCandidates(invoiceSku).map(canonicalSkuKey).filter(Boolean);
  if (invoiceKeys.length === 0) return false;
  const canonicalTokens = String(line.products?.canonical_name ?? "")
    .split(/[^A-Za-z0-9-]+/)
    .map(canonicalSkuKey)
    .filter((token) => Boolean(token) && /\d/.test(token));
  const lineKeys = [line.legacy_item_code, line.products?.sku, line.products?.canonical_name]
    .map(canonicalSkuKey)
    .filter(Boolean)
    .concat(canonicalTokens);
  return invoiceKeys.some((invoiceKey) => lineKeys.includes(invoiceKey));
}

export function prioritizePhysicalFulfillmentLine(left: PhysicalFulfillmentLine, right: PhysicalFulfillmentLine) {
  const leftCompleted = upper(left.fulfillment_status) === "FULFILLED" ? 1 : 0;
  const rightCompleted = upper(right.fulfillment_status) === "FULFILLED" ? 1 : 0;
  if (leftCompleted !== rightCompleted) return leftCompleted > rightCompleted ? -1 : 1;

  const leftFulfilled = Math.max(0, Number(left.fulfilled_qty ?? 0));
  const rightFulfilled = Math.max(0, Number(right.fulfilled_qty ?? 0));
  if (leftFulfilled !== rightFulfilled) return leftFulfilled > rightFulfilled ? -1 : 1;

  const leftMapped = Boolean(left.product_id) ? 1 : 0;
  const rightMapped = Boolean(right.product_id) ? 1 : 0;
  if (leftMapped !== rightMapped) return leftMapped > rightMapped ? -1 : 1;

  const leftApproved = Math.max(0, Number(left.approved_qty ?? 0));
  const rightApproved = Math.max(0, Number(right.approved_qty ?? 0));
  if (leftApproved !== rightApproved) return leftApproved > rightApproved ? -1 : 1;

  return (left.id ?? "").localeCompare(right.id ?? "") < 0 ? -1 : 1;
}

export function getCanonicalPhysicalOrderSummary({
  rawPayload,
  lines,
  manualMappingSkus,
}: {
  rawPayload?: unknown;
  lines: PhysicalFulfillmentLine[] | null | undefined;
  manualMappingSkus?: Set<string>;
}): CanonicalPhysicalOrderSummary {
  const sourceLines = lines ?? [];
  const invoiceItems = parseInvoicePhysicalItems(rawPayload);

  if (invoiceItems.length === 0) {
    const physicalLines = getPhysicalFulfillmentLines(sourceLines, { manualMappingSkus });
    const items = physicalLines.map((line, index) => {
      const quantity = physicalLineOrderedQty(line);
      const fulfilled = Math.min(quantity, Math.max(0, Number(line.fulfilled_qty ?? 0)));
      return {
        key: String(line.id ?? `${line.product_id ?? "line"}-${index}`),
        sku: line.legacy_item_code ?? line.products?.sku ?? null,
        quantity,
        fulfilled,
        remaining: Math.max(0, quantity - fulfilled),
        line,
      };
    });
    const ordered = items.reduce((sum, item) => sum + item.quantity, 0);
    const fulfilled = items.reduce((sum, item) => sum + item.fulfilled, 0);
    const remaining = Math.max(0, ordered - fulfilled);
    return { items, ordered, fulfilled, remaining, lineCount: items.length, isPartiallyFulfilled: fulfilled > 0 && remaining > 0, isComplete: ordered > 0 && remaining === 0 };
  }

  const usedLineIds = new Set<string>();
  const items = invoiceItems.map((item) => {
    const matches = sourceLines
      .filter((candidate) => {
        if (!isPhysicalFulfillmentLine(candidate, { manualMappingSkus })) return false;
        if (candidate.id && usedLineIds.has(candidate.id)) return false;
        return matchesPhysicalLineToInvoiceSku(candidate, item.sku);
      })
      .sort((left, right) => prioritizePhysicalFulfillmentLine(left, right));
    const line = matches[0] ?? null;
    if (line?.id) usedLineIds.add(line.id);
    const fulfilled = Math.min(item.quantity, Math.max(0, Number(line?.fulfilled_qty ?? 0)));
    return {
      key: item.key,
      sku: item.sku,
      quantity: item.quantity,
      fulfilled,
      remaining: Math.max(0, item.quantity - fulfilled),
      line,
    };
  });
  const ordered = items.reduce((sum, item) => sum + item.quantity, 0);
  const fulfilled = items.reduce((sum, item) => sum + item.fulfilled, 0);
  const remaining = Math.max(0, ordered - fulfilled);
  return { items, ordered, fulfilled, remaining, lineCount: items.length, isPartiallyFulfilled: fulfilled > 0 && remaining > 0, isComplete: ordered > 0 && remaining === 0 };
}
