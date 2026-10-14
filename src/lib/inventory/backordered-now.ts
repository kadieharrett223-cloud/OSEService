/** Display-only shortage of existing customer demand before incoming stock arrives. */
export function getBackorderedNow({ onFloor, openDemand }: { onFloor: number; openDemand: number }) {
  // A negative ledger balance is not additional customer demand.
  return Math.max(0, openDemand - Math.max(0, onFloor));
}
