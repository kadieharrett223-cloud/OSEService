export function getAfterIncomingInventory({
  onFloor,
  incoming,
  openDemand,
}: {
  onFloor: number;
  incoming: number;
  openDemand: number;
}) {
  const balanceAfterIncoming = onFloor + incoming - openDemand;

  return {
    availableAfterIncoming: Math.max(0, balanceAfterIncoming),
    backorderedAfterIncoming: Math.max(0, -balanceAfterIncoming),
  };
}