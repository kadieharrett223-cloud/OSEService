export type LogicalOrderParent = {
  id: string;
  source_type?: string | null;
  source_system?: string | null;
  created_at?: string | null;
};

/** QBO is the current operational parent; OLD_ERP/INTERNAL are provenance, not identity. */
export function resolveCanonicalOrderParent<T extends LogicalOrderParent>(parents: T[]) {
  return [...parents].sort((left, right) => {
    const leftQbo = left.source_type === "QBO_INVOICE" ? 0 : 1;
    const rightQbo = right.source_type === "QBO_INVOICE" ? 0 : 1;
    if (leftQbo !== rightQbo) return leftQbo - rightQbo;
    return String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
  })[0] ?? null;
}

export function hasLogicalOrderForInvoice(parents: LogicalOrderParent[]) {
  return parents.length > 0;
}
