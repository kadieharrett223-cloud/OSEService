import type { DemandLineLike } from "./product-demand";

export const REVIEWED_OBLIGATION_RESOLUTION_TYPES = ["SKU_CORRECTION", "REPLACED", "DUPLICATE", "HISTORICAL_FULFILLMENT"] as const;

export type ReviewedObligationResolutionType = typeof REVIEWED_OBLIGATION_RESOLUTION_TYPES[number];

export type ReviewedObligationResolution = {
  source_record_id?: string | null;
  qbo_invoice_line_id?: string | null;
  resolution_type: ReviewedObligationResolutionType;
  status?: "ACTIVE" | "REVOKED" | null;
};

function isActive(resolution: ReviewedObligationResolution) {
  return String(resolution.status ?? "ACTIVE").toUpperCase() === "ACTIVE";
}

/**
 * Removes only explicitly reviewed terminal obligations. A source-record target covers its
 * OLD_ERP representation; a QBO-line target covers every bridged sibling after refresh.
 */
export function excludeReviewedObligationResolutions<T extends DemandLineLike>(
  lines: T[],
  resolutions: readonly ReviewedObligationResolution[] = [],
) {
  const resolvedSourceRecordIds = new Set(
    resolutions.filter(isActive).map((resolution) => resolution.source_record_id).filter((value): value is string => Boolean(value)),
  );
  const resolvedQboLineIds = new Set(
    resolutions.filter(isActive).map((resolution) => resolution.qbo_invoice_line_id).filter((value): value is string => Boolean(value)),
  );

  return lines.filter((line) => !resolvedSourceRecordIds.has(String(line.source_record_id ?? ""))
    && !resolvedQboLineIds.has(String(line.qbo_invoice_line_id ?? ""))
    && !resolvedQboLineIds.has(String(line.logical_demand_key ?? "")));
}