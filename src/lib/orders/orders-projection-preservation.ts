export type ProjectedParent = {
  id: string;
  duplicate_of_order_id?: string | null;
};

/**
 * Orders must classify every active physical parent until a logical-order
 * merger can prove that all parent evidence is represented once.
 */
export function parentsForOrdersProjection<T extends ProjectedParent>(parents: T[]): T[] {
  return parents.filter((parent) => !parent.duplicate_of_order_id);
}