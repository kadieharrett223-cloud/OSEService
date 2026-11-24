/** A zero-quantity row is not a physical unit ready to sell or ship. */
export function completedItemStatus(ordered: number, remaining: number, nonInventory: boolean) {
  if (nonInventory || ordered <= 0) return "N/A";
  return remaining <= 0 ? "Shipped" : null;
}
