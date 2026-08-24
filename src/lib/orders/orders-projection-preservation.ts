export type ProjectedParent = {
  id: string;
  duplicate_of_order_id?: string | null;
};

/**
 * Preserves active physical parents for evidence/audit surfaces. Customer-facing
 * lists use buildLogicalOrdersProjection to represent this evidence once.
 */
export function parentsForOrdersProjection<T extends ProjectedParent>(parents: T[]): T[] {
  return parents.filter((parent) => !parent.duplicate_of_order_id);
}