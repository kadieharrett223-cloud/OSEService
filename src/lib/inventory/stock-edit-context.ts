import { authoritativeStockProductIds, canonicalSkuKey, preferredOperationalSku } from "../products/canonical-sku";
import { isOpenCustomerQueueLine } from "../demand/product-demand";
import { qboSkuCandidates } from "../orders/quickbooks-refresh";

type Product = { id: string; sku: string | null; canonical_name: string | null; source_record_id?: string | null };
type Transaction = { product_id: string | null; source_type: string | null };
type DemandLine = Parameters<typeof isOpenCustomerQueueLine>[0] & { legacy_item_code?: string | null };

/** The same identity rules must drive both the displayed row and its stock save. */
export function inventoryOperationalIdentity(products: Product[], aliases: Array<{ product_id: string | null; alias: string | null }>, archive: Record<string, string>, lines: DemandLine[] = []) {
  const operationalSkuByProduct = new Map<string, string>();
  for (const p of products) {
    const candidate = preferredOperationalSku(p.sku, [], p.canonical_name, archive[p.source_record_id ?? ""]);
    if (candidate && !/^\d+$/.test(candidate)) operationalSkuByProduct.set(p.id, candidate);
  }
  for (const alias of aliases) {
    if (!alias.product_id || !alias.alias) continue;
    const candidate = preferredOperationalSku(null, [alias.alias]);
    if (candidate && !/^\d+$/.test(candidate) && !operationalSkuByProduct.has(alias.product_id)) operationalSkuByProduct.set(alias.product_id, candidate);
  }
  const demandSkuCountsByProduct = new Map<string, Map<string, number>>();
  for (const line of lines) {
    if (!line.product_id || !isOpenCustomerQueueLine(line) || !line.legacy_item_code) continue;
    const candidate = qboSkuCandidates(line.legacy_item_code).at(-1) ?? line.legacy_item_code.trim().toUpperCase();
    if (!candidate || /^\d+$/.test(candidate)) continue;
    const counts = demandSkuCountsByProduct.get(line.product_id) ?? new Map<string, number>();
    counts.set(candidate, (counts.get(candidate) ?? 0) + Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)));
    demandSkuCountsByProduct.set(line.product_id, counts);
  }
  for (const [id, counts] of demandSkuCountsByProduct) {
    const preferred = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (preferred) operationalSkuByProduct.set(id, preferred);
  }
  return { operationalSkuByProduct, demandSkuCountsByProduct };
}

/** Resolve recount scope without changing the existing stock ownership/display rules. */
export function stockEditContext(products: Product[], aliases: Array<{ product_id: string | null; alias: string | null }>, archive: Record<string, string>, transactions: Transaction[], sku: string, lines: DemandLine[] = []) {
  const { operationalSkuByProduct } = inventoryOperationalIdentity(products, aliases, archive, lines);
  const keys = new Map(products.map(p => [p.id, canonicalSkuKey(operationalSkuByProduct.get(p.id) ?? p.sku) || p.id]));
  const owners = authoritativeStockProductIds(products, keys,
    new Set(transactions.flatMap(t => t.product_id ? [t.product_id] : [])),
    new Set(transactions.filter(t => ["ADJUSTMENT", "CONTAINER_RECEIVED", "RECOUNT"].includes(String(t.source_type).toUpperCase())).flatMap(t => t.product_id ? [t.product_id] : [])));
  const groupIds = products.filter(p => keys.get(p.id) === canonicalSkuKey(sku)).map(p => p.id).sort();
  const ownerIds = groupIds.filter(id => owners.has(id));
  // A product with no ledger yet can still receive its first explicit count.
  const targetId = ownerIds[0] ?? products.find(p => groupIds.includes(p.id) && canonicalSkuKey(p.sku) === canonicalSkuKey(sku))?.id ?? groupIds[0];
  return { groupIds, ownerIds, targetId };
}
