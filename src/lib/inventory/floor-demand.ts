/** Explicit incoming reservations cannot also consume today's floor availability. */
export function getCommittedFloor(input: { onFloor: number; openDemand: number; floorCommitted: number; containerReserved: number }) {
  const floorDemand = Math.max(0, input.openDemand - Math.max(0, input.containerReserved));
  return Math.max(input.floorCommitted, Math.min(floorDemand, Math.max(0, input.onFloor)));
}
