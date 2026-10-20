import { canonicalSkuKey } from "../products/canonical-sku";
import { inventoryOperationalIdentity, stockEditContext } from "./stock-edit-context";

/** Pin the SAME ownership used by Inventory, not a name-prefix or invoice guess.
 * Existing owner balances remain separate; only excluded catalog copies route
 * to the group's recount target. No historical balances are summed or reset.
 */
export function buildStockRoutes(
  products: Parameters<typeof stockEditContext>[0],
  aliases: Parameters<typeof stockEditContext>[1],
  archive: Parameters<typeof stockEditContext>[2],
  transactions: Parameters<typeof stockEditContext>[3],
  lines: Parameters<typeof stockEditContext>[5] = [],
) {
  const { operationalSkuByProduct } = inventoryOperationalIdentity(products, aliases, archive, lines);
  const contexts = new Map<string, ReturnType<typeof stockEditContext>>();
  return products.map(product => {
    const sku = operationalSkuByProduct.get(product.id) ?? product.sku ?? product.id;
    const key = canonicalSkuKey(sku) || product.id;
    let context = contexts.get(key);
    if (!context) {
      context = stockEditContext(products, aliases, archive, transactions, sku, lines);
      contexts.set(key, context);
    }
    return {
      product_id: product.id,
      stock_product_id: context.ownerIds.includes(product.id) ? product.id : context.targetId ?? product.id,
      operational_key: key,
    };
  });
}
