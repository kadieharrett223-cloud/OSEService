import { demandLineIdentity, type DemandLineLike } from "./product-demand";

/** Exclude every representation of a paused obligation, without altering demand or stock. */
export function pausedCustomerQueueIdentities<T extends DemandLineLike & { customer_queue_paused?: boolean | null }>(lines: T[]) {
  return new Set(lines.filter((line) => line.customer_queue_paused).map(demandLineIdentity));
}
