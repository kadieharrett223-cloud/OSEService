/** A catalog/software problem is never evidence that goods bypassed warehouse stock. */
export const MAPPING_SOURCE_ERROR = "A mapping or software problem cannot be used as Other fulfillment. Correct the underlying problem, then use Warehouse/Container for warehouse goods. Historical shipments require dated evidence and recount review.";

export function hasMappingSourceProblem(notes: string | null | undefined) {
  return /(?:mapping|mapped)\s*(?:error|issue|problem|fix|correction)|(?:missing|incorrect|wrong|broken)\s*(?:product\s*)?mapping|\bunmapped\b|\b(?:OCC|ERP|software|system|sync|QuickBooks|QBO)\s+(?:(?:mapping|sync)\s+)?(?:error|issue|problem|bug|fix|correction)\b/i.test(notes ?? "");
}

export function isMappingSourceBypass(line: { fulfillment_source?: string | null; fulfillment_notes?: string | null }) {
  return String(line.fulfillment_source ?? "").trim().toUpperCase() === "OTHER" && hasMappingSourceProblem(line.fulfillment_notes);
}

/** Conservative coverage of an open obligation; does not rewrite its saved source or move stock. */
export function inventoryCoverageSource(line: { fulfillment_source?: string | null; fulfillment_notes?: string | null }) {
  return isMappingSourceBypass(line) ? "WAREHOUSE" : line.fulfillment_source;
}
