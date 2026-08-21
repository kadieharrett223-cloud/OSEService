export type LogicalOrderParent = {
  id: string;
  source_type?: string | null;
  source_system?: string | null;
  created_at?: string | null;
  source_invoice_id?: string | null;
  duplicate_of_order_id?: string | null;
};

export function dedupeOrderParentsByInvoice<T extends LogicalOrderParent>(parents: T[]) {
  const activeParents = parents.filter((parent) => !parent.duplicate_of_order_id);
  const byInvoice = new Map<string, T[]>();

  for (const parent of activeParents) {
    const invoiceKey = String(parent.source_invoice_id ?? parent.id ?? "").trim();
    if (!invoiceKey) {
      byInvoice.set(parent.id, [parent]);
      continue;
    }
    const existing = byInvoice.get(invoiceKey) ?? [];
    existing.push(parent);
    byInvoice.set(invoiceKey, existing);
  }

  return Array.from(byInvoice.values()).map((group) => {
    return group.sort((left, right) => {
      const leftQbo = left.source_type === "QBO_INVOICE" ? 0 : 1;
      const rightQbo = right.source_type === "QBO_INVOICE" ? 0 : 1;
      if (leftQbo !== rightQbo) return leftQbo - rightQbo;
      return String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
    })[0] ?? group[0];
  });
}

/** QBO is the current operational parent; OLD_ERP/INTERNAL are provenance, not identity. */
export function resolveCanonicalOrderParent<T extends LogicalOrderParent>(parents: T[]) {
  return dedupeOrderParentsByInvoice(parents).sort((left, right) => {
    const leftQbo = left.source_type === "QBO_INVOICE" ? 0 : 1;
    const rightQbo = right.source_type === "QBO_INVOICE" ? 0 : 1;
    if (leftQbo !== rightQbo) return leftQbo - rightQbo;
    return String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""));
  })[0] ?? null;
}

export function hasLogicalOrderForInvoice(parents: LogicalOrderParent[]) {
  return dedupeOrderParentsByInvoice(parents).length > 0;
}
