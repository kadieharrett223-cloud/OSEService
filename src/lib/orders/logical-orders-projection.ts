import { resolveCanonicalOrderParent, type LogicalOrderParent } from "./order-identity";

export type LogicalProjectionParent<Line> = LogicalOrderParent & {
  shipping_order_lines?: Line[] | null;
};

/**
 * Builds one list projection per active source invoice while preserving every
 * underlying line for status, totals, and route-safe canonical selection.
 */
export function buildLogicalOrdersProjection<Line, Parent extends LogicalProjectionParent<Line>>(
  parents: Parent[],
): Array<Parent & { shipping_order_lines: Line[] }> {
  const activeParents = parents.filter((parent) => !parent.duplicate_of_order_id);
  const groups = new Map<string, Parent[]>();

  for (const parent of activeParents) {
    const key = String(parent.source_invoice_id ?? parent.id).trim() || parent.id;
    groups.set(key, [...(groups.get(key) ?? []), parent]);
  }

  return Array.from(groups.values()).map((group) => {
    const canonical = resolveCanonicalOrderParent(group) ?? group[0];
    return {
      ...canonical,
      shipping_order_lines: group.flatMap((parent) => parent.shipping_order_lines ?? []),
    };
  });
}
