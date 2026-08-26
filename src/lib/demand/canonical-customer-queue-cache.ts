import { revalidateTag } from "next/cache";

export const CANONICAL_CUSTOMER_QUEUE_CACHE_TAG = "canonical-customer-queue";

export function revalidateCanonicalCustomerQueue() {
  revalidateTag(CANONICAL_CUSTOMER_QUEUE_CACHE_TAG, { expire: 0 });
}