import { inventoryOperationalIdentity } from "../inventory/stock-edit-context";
import { canonicalSkuKey } from "../products/canonical-sku";

/** Read-only queue grouping: exactly the identity already used by inventory display. */
export function customerQueueProductKeys(...args: Parameters<typeof inventoryOperationalIdentity>) {
  const { operationalSkuByProduct } = inventoryOperationalIdentity(...args);
  return new Map(args[0].map((product) => [
    product.id,
    canonicalSkuKey(operationalSkuByProduct.get(product.id) ?? product.sku) || product.id,
  ]));
}
