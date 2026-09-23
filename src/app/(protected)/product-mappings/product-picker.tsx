type ProductOption = {
  id: string;
  sku: string;
  canonical_name: string;
};

export function ProductPicker({
  products,
  name = "productId",
}: {
  products: ProductOption[];
  name?: string;
}) {
  return (
    <select name={name} required defaultValue="" className="input mt-1 w-full">
      <option value="" disabled>Select inventory product…</option>
      {products.map((product) => (
        <option key={product.id} value={product.id}>
          {product.sku} — {product.canonical_name}
        </option>
      ))}
    </select>
  );
}
