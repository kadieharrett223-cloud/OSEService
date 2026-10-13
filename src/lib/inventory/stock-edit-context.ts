import { authoritativeStockProductIds, canonicalSkuKey, preferredOperationalSku } from "../products/canonical-sku";

type Product = { id: string; sku: string | null; canonical_name: string | null; source_record_id: string | null };
type Transaction = { product_id: string | null; source_type: string | null };

/** Resolve recount scope without changing the existing stock ownership/display rules. */
export function stockEditContext(products: Product[], aliases: Array<{ product_id: string | null; alias: string | null }>, archive: Record<string, string>, transactions: Transaction[], sku: string) {
  const keys = new Map(products.map(p => [p.id, canonicalSkuKey(preferredOperationalSku(p.sku, aliases.filter(a => a.product_id === p.id).map(a => a.alias), p.canonical_name, archive[p.source_record_id ?? ""])) || p.id]));
  const owners = authoritativeStockProductIds(products, keys,
    new Set(transactions.flatMap(t => t.product_id ? [t.product_id] : [])),
    new Set(transactions.filter(t => ["ADJUSTMENT", "CONTAINER_RECEIVED", "RECOUNT"].includes(String(t.source_type).toUpperCase())).flatMap(t => t.product_id ? [t.product_id] : [])));
  const groupIds = products.filter(p => keys.get(p.id) === canonicalSkuKey(sku)).map(p => p.id).sort();
  const ownerIds = groupIds.filter(id => owners.has(id));
  // A product with no ledger yet can still receive its first explicit count.
  const targetId = ownerIds[0] ?? products.find(p => groupIds.includes(p.id) && canonicalSkuKey(p.sku) === canonicalSkuKey(sku))?.id ?? groupIds[0];
  return { groupIds, ownerIds, targetId };
}
