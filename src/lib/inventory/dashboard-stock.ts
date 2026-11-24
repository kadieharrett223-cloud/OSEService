type Product = { id: string; sku: string | null };
type Route = { product_id: string; stock_product_id: string; operational_key: string };
type Movement = { product_id: string | null; bucket: string | null; delta: number | null };

/** Dashboard totals use the same pinned stock owners as physical inventory. */
export function dashboardStockSummary(products: Product[], movements: Movement[], routes: Route[]) {
  const routeById = new Map(routes.map(route => [route.product_id, route]));
  const groups = new Map<string, { onFloor: number }>();
  const allowed = new Set<string>();
  for (const product of products) {
    if (product.sku?.trim().toUpperCase() === "TEST") continue;
    const route = routeById.get(product.id);
    if (!route) throw new Error("Inventory stock routing is incomplete; dashboard totals cannot be calculated.");
    if (route.stock_product_id !== product.id) continue;
    allowed.add(product.id);
    if (!groups.has(route.operational_key)) groups.set(route.operational_key, { onFloor: 0 });
  }
  for (const movement of movements) {
    if (!movement.product_id || !allowed.has(movement.product_id)) continue;
    const group = groups.get(routeById.get(movement.product_id)!.operational_key)!;
    if (movement.bucket === "ON_FLOOR") group.onFloor += Number(movement.delta ?? 0);
  }
  const rows = [...groups.values()];
  return {
    onFloorInventory: rows.reduce((sum, row) => sum + row.onFloor, 0),
  };
}

/** Sum the same per-product available-now values that salespeople see in Inventory. */
export function dashboardAvailabilitySummary(rows: ReadonlyArray<{ availableNow: number }>) {
  return {
    availableInventory: rows.reduce((sum, row) => sum + row.availableNow, 0),
    lowOutOfStock: rows.filter(row => row.availableNow <= 5).length,
  };
}
