export type ContainerProductOption = { id: string; sku: string; name: string; status?: string | null };

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
