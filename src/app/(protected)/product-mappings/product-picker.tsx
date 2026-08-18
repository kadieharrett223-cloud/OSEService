"use client";

import { useRef, useState } from "react";

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
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const selectedProduct = products.find((product) => product.id === selectedId) ?? null;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProducts = products.filter((product) => {
    if (!normalizedQuery) return true;
    return `${product.sku} ${product.canonical_name}`.toLowerCase().includes(normalizedQuery);
  });

  function focusPicker() {
    containerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <div ref={containerRef} className="relative mt-1">
      <input type="hidden" name={name} value={selectedId} />
      <input
        value={selectedProduct ? `${selectedProduct.sku} — ${selectedProduct.canonical_name}` : query}
        onChange={(event) => {
          setSelectedId("");
          setQuery(event.target.value);
        }}
        onFocus={() => {
          focusPicker();
          setIsOpen(true);
        }}
        placeholder="Search SKU or product name..."
        className="input w-full"
        autoComplete="off"
        required
      />
      {isOpen ? <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-[#dbe3ee] bg-white shadow-lg">
        {filteredProducts.length > 0 ? filteredProducts.map((product) => (
          <button
            key={product.id}
            type="button"
            onClick={() => {
              setSelectedId(product.id);
              setQuery("");
              setIsOpen(false);
            }}
            className={`block w-full border-b border-[#f1f5f9] px-3 py-2 text-left text-sm last:border-0 hover:bg-[#f8fafc] ${selectedId === product.id ? "bg-[#fff8ec]" : ""}`}
          >
            <span className="font-semibold text-[#111827]">{product.sku}</span>
            <span className="ml-2 text-[#475569]">{product.canonical_name}</span>
          </button>
        )) : (
          <p className="px-3 py-3 text-sm text-[#64748b]">No products match this search.</p>
        )}
      </div> : null}
    </div>
  );
}
