import { revalidateTag } from "next/cache";

/**
 * Tags the read-only inventory base model.  Inventory writes and fulfillment
 * writes expire this model immediately; it must never be used as stock truth.
 */
export const INVENTORY_READ_MODEL_CACHE_TAG = "inventory-read-model";

export function revalidateInventoryReadModelCache() {
  revalidateTag(INVENTORY_READ_MODEL_CACHE_TAG, { expire: 0 });
}
