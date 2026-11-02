import { containerProductCode } from "./product-code";
import { isNonInventoryPhysicalLine } from "../orders/physical-fulfillment";
import { canonicalSkuKey } from "../products/canonical-sku";

export type ContainerProductOption = { id: string; sku: string; name: string; status?: string | null };

export function containerInventoryOptions(
  products: Array<{ id: string; sku: string | null; canonical_name: string | null; status: string | null }>,
  routes: Array<{ product_id: string; stock_product_id: string; operational_key?: string }>,
) {
  const routeById = new Map(routes.map(r => [r.product_id, r]));
  const productById = new Map(products.map(p => [p.id, p]));
  const owners = new Set(routes.filter(r => r.product_id === r.stock_product_id).map(r => r.product_id));
  const candidates = products.filter(p => owners.has(p.id) && p.status?.toUpperCase() === "ACTIVE"
    && p.sku?.trim().toUpperCase() !== "TEST"
    && !/^(?:DISCOUNT|SHIPPING|FREIGHT|SALESTAX|TAXADJUSTMENT)/.test(routeById.get(p.id)?.operational_key ?? "")
    && !isNonInventoryPhysicalLine({ products: p }))
    .map(p => {
      const code = containerProductCode(p.sku, p.canonical_name);
      const routedCode = routeById.get(p.id)?.operational_key;
      // Component names often begin with the lift they fit, not their own code.
      // Never label a cylinder or seal kit as the complete lift.
      return { id: p.id, sku: routedCode && routedCode.length <= 24 && canonicalSkuKey(code) !== routedCode ? routedCode : code, name: p.canonical_name ?? "" };
    })
    .filter(p => p.sku && !/^\d+$/.test(p.sku))
    .sort((a, b) => {
      // Prefer the route explicitly used by the current natural product code.
      const preferred = (id: string) => routes.some(r => r.stock_product_id === id
        && !/^\d+$/.test(productById.get(r.product_id)?.sku ?? "")
        && canonicalSkuKey(productById.get(r.product_id)?.sku) === r.operational_key);
      return Number(preferred(b.id)) - Number(preferred(a.id))
        || String(productById.get(a.id)?.sku).localeCompare(String(productById.get(b.id)?.sku), undefined, { numeric: true })
        || a.id.localeCompare(b.id);
    });
  // Some historical groups retain multiple ledgers. Choose a stable manifest
  // identity per reviewed operational key; never merge or rewrite those ledgers.
  const byKey = new Map<string, ContainerProductOption>();
  for (const p of candidates) {
    const key = routeById.get(p.id)?.operational_key ?? canonicalSkuKey(p.sku);
    if (!byKey.has(key)) byKey.set(key, p);
  }
  return [...byKey.values()].sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }));
}

export function matchingContainerProducts(products: ContainerProductOption[], search: string) {
  const query = productLookupText(search);
  if (!query) return products;
  // A lift model is also mentioned in compatible accessory descriptions. Prefer
  // actual product codes so a model lookup doesn't become an accessory list.
  const exact = products.filter(p => productLookupText(p.sku) === query);
  if (exact.length) return exact;
  const byCode = products.filter(p => productLookupText(p.sku).includes(query));
  return byCode.length ? byCode : products.filter(p => productLookupText(p.name).includes(query));
}

export function productLookupText(value: string) {
  return value.trim().toUpperCase().replace(/_/g, "-");
}

export function validateContainerProductRows(formData: FormData, products: ContainerProductOption[]) {
  const ids = formData.getAll("product_id").map(String);
  const quantities = formData.getAll("product_qty").map(String);
  if (!ids.length && (formData.has("product_sku") || formData.has("products"))) {
    throw new Error("Refresh Containers and select an existing product from the lookup. Typed SKUs cannot create products.");
  }
  const active = new Set(products.filter(p => !p.status || p.status.toUpperCase() === "ACTIVE").map(p => p.id));
  const rows = new Map<string, number>();
  for (let i = 0; i < Math.max(ids.length, quantities.length); i++) {
    const id = (ids[i] ?? "").trim();
    const rawQty = (quantities[i] ?? "").trim();
    if (!id && !rawQty) continue;
    if (!active.has(id)) throw new Error("Select an existing active product for every quantity.");
    const qty = Number(rawQty);
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error("Enter a positive whole-number quantity for each selected product.");
    const total = (rows.get(id) ?? 0) + qty;
    if (!Number.isSafeInteger(total)) throw new Error("Product quantity is too large.");
    rows.set(id, total);
  }
  return [...rows].map(([productId, qty]) => ({ productId, qty }));
}
