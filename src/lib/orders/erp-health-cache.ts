import { revalidateTag } from "next/cache";

export const ERP_HEALTH_CACHE_TAG = "erp-health";

export function revalidateErpHealth() {
  revalidateTag(ERP_HEALTH_CACHE_TAG, { expire: 0 });
}