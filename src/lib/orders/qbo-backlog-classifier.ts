export type QboBacklogDecision =
  | "IMPORTED"
  | "ALREADY PRESENT — SKIPPED"
  | "CLOSED — SKIPPED"
  | "MANUAL DUPLICATE — REVIEW"
  | "UNMAPPED — REVIEW";

export type QboBacklogLineEvidence = {
  hasExactExistingLine: boolean;
  hasTerminalOrReviewedResolution: boolean;
  hasMappedProduct: boolean;
  hasPossibleManualDuplicate: boolean;
};

/** Exact QBO identity and reviewed lifecycle facts always take precedence over similarity evidence. */
export function classifyQboBacklogLine(evidence: QboBacklogLineEvidence): QboBacklogDecision {
  if (evidence.hasTerminalOrReviewedResolution) return "CLOSED — SKIPPED";
  if (evidence.hasExactExistingLine) return "ALREADY PRESENT — SKIPPED";
  if (!evidence.hasMappedProduct) return "UNMAPPED — REVIEW";
  if (evidence.hasPossibleManualDuplicate) return "MANUAL DUPLICATE — REVIEW";
  return "IMPORTED";
}