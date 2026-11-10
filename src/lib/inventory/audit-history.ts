import { canonicalSkuKey } from "../products/canonical-sku";

export type AuditProduct = { id: string; sku: string | null; canonical_name: string | null };
export type AuditRoute = { product_id: string; stock_product_id: string; operational_key: string };
export type AuditMovement = {
  id: string; product_id: string; bucket: string; delta: number; before_qty: number; after_qty: number;
  reason: string; source_type: string; source_event_key: string | null; actor_id: string | null; created_at: string;
};

/** Follow pinned stock ownership, including movements saved under a different catalog identity. */
export function auditProductScope(products: AuditProduct[], aliases: Array<{ product_id: string | null; alias: string | null }>, routes: AuditRoute[], sku: string) {
  if (!sku || sku === "ALL") return products;
  const key = canonicalSkuKey(sku);
  const routeMatches = routes.filter(route => route.operational_key === key);
  const direct = products.filter(product => canonicalSkuKey(product.sku) === key);
  const matchedIds = new Set(routeMatches.map(route => route.product_id));
  for (const product of direct) matchedIds.add(product.id);
  // Only fall back to aliases when there is no authoritative SKU/route match.
  if (!matchedIds.size) for (const alias of aliases) {
    if (alias.product_id && canonicalSkuKey(alias.alias) === key) matchedIds.add(alias.product_id);
  }
  const keys = new Set(routes.filter(route => matchedIds.has(route.product_id)).map(route => route.operational_key));
  for (const route of routes) if (keys.has(route.operational_key)) {
    matchedIds.add(route.product_id);
    matchedIds.add(route.stock_product_id);
  }
  return products.filter(product => matchedIds.has(product.id));
}

export function auditCurrentFloor(productIds: string[], routes: AuditRoute[], movements: AuditMovement[]) {
  const byId = new Map(routes.map(route => [route.product_id, route]));
  const owners = new Set<string>();
  for (const id of productIds) {
    const route = byId.get(id);
    if (!route || byId.get(route.stock_product_id)?.stock_product_id !== route.stock_product_id) {
      throw new Error("Stock routing is incomplete. Current stock cannot be verified.");
    }
    owners.add(route.stock_product_id);
  }
  return movements.reduce((sum, row) => sum + (owners.has(row.product_id) && row.bucket === "ON_FLOOR" ? Number(row.delta) : 0), 0);
}

/** An event is linked only by its unique event key, never an invoice number or a quantity guess. */
export function auditFulfillmentMovements(eventKey: string | null, movements: AuditMovement[]) {
  return eventKey ? movements.filter(row => row.source_event_key === `${eventKey}:ON_FLOOR`) : [];
}

export function auditRowsInPeriod<T extends { created_at: string }>(rows: T[], start: string | null, end: string) {
  const through = Date.parse(end);
  const since = start ? Date.parse(start) : -Infinity;
  return rows.filter(row => Date.parse(row.created_at) >= since && Date.parse(row.created_at) <= through);
}
