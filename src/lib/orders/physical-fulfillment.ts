const NON_INVENTORY_TEXT = /discount|shipping|freight|sales tax|tax adjustment|\bnote\b|\bservice\b|\binstall(?:ation)?\b/i;
const EXCLUDED_PHYSICAL_STATES = new Set(["CANCELLED", "REMOVED", "DENIED"]);

export type PhysicalFulfillmentLine = {
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

export type PhysicalFulfillmentTotals = {
  ordered: number;
  fulfilled: number;
  remaining: number;
  lineCount: number;
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
