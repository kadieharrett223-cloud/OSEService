import { revalidateTag } from "next/cache";

export const ORDERS_PROJECTION_CACHE_TAG = "orders-projection";

export function revalidateOrdersProjection() {
  revalidateTag(ORDERS_PROJECTION_CACHE_TAG, { expire: 0 });
}
