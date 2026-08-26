import { isNonInventoryQuickbooksLine } from "./quickbooks-refresh";

export type QboForwardIntakeDecision =
  | "AUTO_IMPORT"
  | "NO_INVENTORY_DEMAND"
  | "ALREADY_REPRESENTED"
  | "CLOSED"
  | "MAPPING_REVIEW"
  | "MANUAL_DUPLICATE_REVIEW";

export type QboForwardIntakeEvidence = {
  isPaymentEligible: boolean;
  isInventoryDemandLine: boolean;
  hasExactExistingLine: boolean;
  hasTerminalOrReviewedResolution: boolean;
  hasMappedProduct: boolean;
  hasPossibleManualDuplicate: boolean;
  hasConflictingSkuIdentity: boolean;
};

/** Accounting and service rows never create inventory demand, even if an alias happens to exist. */
export function isInventoryDemandQuickbooksLine(line: { qbo_sku?: string | null; source_description?: string | null; ordered_qty?: number | null }) {
  const sku = String(line.qbo_sku ?? "").trim().toLowerCase();
  return Number(line.ordered_qty ?? 0) > 0
    && !isNonInventoryQuickbooksLine(line)
    && !/^misc(?:ellaneous)?\s+charge\b/.test(sku);
}

/** Exact QBO identity and reviewed lifecycle facts take precedence over mapping and similarity evidence. */
export function classifyQboForwardIntakeLine(evidence: QboForwardIntakeEvidence): QboForwardIntakeDecision {
  if (!evidence.isPaymentEligible) return "NO_INVENTORY_DEMAND";
  if (evidence.hasTerminalOrReviewedResolution) return "CLOSED";
  if (evidence.hasExactExistingLine) return "ALREADY_REPRESENTED";
  if (!evidence.isInventoryDemandLine) return "NO_INVENTORY_DEMAND";
  if (!evidence.hasMappedProduct) return "MAPPING_REVIEW";
  if (evidence.hasConflictingSkuIdentity || evidence.hasPossibleManualDuplicate) return "MANUAL_DUPLICATE_REVIEW";
  return "AUTO_IMPORT";
}
