import { demandLineIdentity, type DemandLineLike } from "./product-demand";
import { normalizeFulfillmentSource } from "@/lib/orders/fulfillment-source";

/** Use canonical saved sources so stale duplicate assignments cannot override a later save. */
export function otherFulfillmentQueueIdentities<T extends DemandLineLike & { fulfillment_source?: string | null }>(canonicalLines: T[]) {
  return new Set(canonicalLines.filter((line) => ["OTHER", "CUSTOMER_NOT_READY"].includes(normalizeFulfillmentSource(line.fulfillment_source) ?? "")).map(demandLineIdentity));
}
