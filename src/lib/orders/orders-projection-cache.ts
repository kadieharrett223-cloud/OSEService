import { revalidateTag } from "next/cache";
import { revalidateCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-cache";
import { revalidateErpHealth } from "@/lib/orders/erp-health-cache";

export const ORDERS_PROJECTION_CACHE_TAG = "orders-projection";

export function revalidateOrdersProjection() {
  revalidateTag(ORDERS_PROJECTION_CACHE_TAG, { expire: 0 });
  revalidateCanonicalCustomerQueue();
  revalidateErpHealth();
}
