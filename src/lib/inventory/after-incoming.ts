export function getAfterIncomingInventory({
  onFloor,
  incoming,
  openDemand,
}: {
  onFloor: number;
  incoming: number;
  openDemand: number;
}) {
  const netAfterIncoming = onFloor + incoming - openDemand;

  return {
    netAfterIncoming,
    availableAfterIncoming: Math.max(0, netAfterIncoming),
    backorderedAfterIncoming: Math.max(0, -netAfterIncoming),
  };
}