"use client";

import { useState } from "react";

type AddProductModalProps = {
  createAction: (formData: FormData) => void | Promise<void>;
};

export function AddProductModal({ createAction }: AddProductModalProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => setOpen(true)}>
        <span aria-hidden="true" className="text-lg leading-none">+</span>
        Add Product
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#0b1020]/55 p-4 md:p-8">
          <div className="my-4 w-full max-w-lg rounded-xl border border-[#e5e7eb] bg-white p-5 shadow-2xl md:my-10">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Product catalog</p>
                <h2 className="mt-1 text-xl font-semibold text-[#0f172a]">Add Product</h2>
              </div>
              <button
                type="button"
                aria-label="Close add product dialog"
                className="rounded-md px-2 py-1 text-xl leading-none text-[#64748b] hover:bg-[#f1f5f9] hover:text-[#0f172a]"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>

            <form action={createAction} className="mt-5 space-y-4">
              <div>
                <label htmlFor="add-product-sku" className="label">SKU</label>
                <input id="add-product-sku" name="sku" className="input" placeholder="e.g. 4PHR-9X" required autoFocus />
              </div>

              <div>
                <label htmlFor="add-product-name" className="label">Product name</label>
                <input id="add-product-name" name="canonical_name" className="input" placeholder="Product name" required />
              </div>

              <div>
                <label htmlFor="add-product-description" className="label">Description <span className="font-normal text-[#94a3b8]">(optional)</span></label>
                <textarea id="add-product-description" name="description" className="input min-h-24 resize-y" placeholder="Additional product details" />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="add-product-quantity" className="label">Starting on-floor quantity</label>
                  <input id="add-product-quantity" name="on_floor_qty" type="number" min="0" step="0.01" defaultValue="0" className="input" />
                </div>
                <div>
                  <label htmlFor="add-product-group" className="label">Inventory group <span className="font-normal text-[#94a3b8]">(optional)</span></label>
                  <input id="add-product-group" name="inventory_group" className="input" placeholder="e.g. Lifts" />
                </div>
              </div>

              <div>
                <label htmlFor="add-product-sort-order" className="label">Display order <span className="font-normal text-[#94a3b8]">(optional)</span></label>
                <input id="add-product-sort-order" name="inventory_sort_order" type="number" step="1" className="input" placeholder="Lower numbers appear first" />
              </div>

              <div className="flex justify-end gap-2 border-t border-[#eef2f7] pt-4">
                <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
                <button type="submit" className="btn-primary">Create Product</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
