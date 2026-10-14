"use client";

import { useState } from "react";
import { productLookupText, type ContainerProductOption } from "@/lib/containers/product-selection";

type AddContainerModalProps = {
  createAction: (formData: FormData) => void | Promise<void>;
  products: ContainerProductOption[];
};

type ProductRow = {
  id: string;
  productId: string;
  search: string;
  qty: string;
};

export function AddContainerModal({ createAction, products }: AddContainerModalProps) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ProductRow[]>([{ id: "row-1", productId: "", search: "", qty: "" }]);

  function addRow() {
    setRows((current) => [...current, { id: `row-${current.length + 1}-${Date.now()}`, productId: "", search: "", qty: "" }]);
  }

  function removeRow(id: string) {
    setRows((current) => {
      if (current.length === 1) return [{ ...current[0], productId: "", search: "", qty: "" }];
      return current.filter((row) => row.id !== id);
    });
  }

  function updateRow(id: string, key: "productId" | "search" | "qty", value: string) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [key]: value } : row)));
  }

  return (
    <>
      <button type="button" className="btn-primary inline-flex" onClick={() => setOpen(true)}>
        Add Container
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#0b1020]/55 p-4 md:p-8">
          <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-[#d1d5db] bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-2xl font-semibold text-[#111827]">Add Container</h2>
                <p className="mt-1 text-sm text-[#5a5a5a]">Create a container and optional line items.</p>
              </div>
              <button
                type="button"
                className="rounded-md border border-[#d1d5db] px-3 py-1.5 text-sm font-medium text-[#374151] hover:bg-[#f3f4f6]"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>

            <form action={createAction} className="mt-5 space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <label className="label" htmlFor="container_number">Container #</label>
                  <input id="container_number" name="container_number" className="input" required />
                </div>
                <div>
                  <label className="label" htmlFor="supplier">Supplier</label>
                  <input id="supplier" name="supplier" className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="order_date">Order Date</label>
                  <input id="order_date" name="order_date" type="date" className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="entered_date">Entered Date</label>
                  <input id="entered_date" name="entered_date" type="date" className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="payment_status">Payment Status</label>
                  <select id="payment_status" name="payment_status" className="select" defaultValue="Pending">
                    <option value="Pending">Pending</option>
                    <option value="Partially Paid">Partially Paid</option>
                    <option value="Paid">Paid</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="lifecycle_status">Lifecycle Status</label>
                  <select id="lifecycle_status" name="lifecycle_status" className="select" defaultValue="ORDERED">
                    <option value="ORDERED">ORDERED</option>
                    <option value="PRODUCTION">PRODUCTION</option>
                    <option value="INBOUND">INBOUND</option>
                    <option value="RECEIVED">RECEIVED</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="remaining_balance">Remaining Balance</label>
                  <input id="remaining_balance" name="remaining_balance" type="number" step="0.01" className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="tracking_number">Tracking Number</label>
                  <input id="tracking_number" name="tracking_number" className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="eta_estimated_date">Estimated ETA</label>
                  <input id="eta_estimated_date" name="eta_estimated_date" type="date" className="input" />
                </div>
                <div>
                  <label className="label" htmlFor="eta_confirmed_date">Confirmed ETA</label>
                  <input id="eta_confirmed_date" name="eta_confirmed_date" type="date" className="input" />
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label className="label" htmlFor="product-row-0">Products / Quantities</label>
                  <button
                    type="button"
                    className="rounded-md border border-[#d1d5db] px-2.5 py-1 text-xs font-semibold text-[#374151] hover:bg-[#f3f4f6]"
                    onClick={addRow}
                  >
                    Add Row
                  </button>
                </div>

                <div className="space-y-2">
                  {rows.map((row, index) => (
                    <div key={row.id} className="grid grid-cols-[1fr_130px_88px] gap-2">
                      <div className="min-w-0 space-y-1">
                        <input id={`product-row-${index}`} className="input"
                          aria-label={`Search product for row ${index + 1}`}
                          placeholder="Search existing products by SKU or name…"
                          value={row.search} onChange={event => updateRow(row.id, "search", event.target.value)} />
                        <select name="product_id" className="select"
                          aria-label={`Select product for row ${index + 1}`}
                          required={Boolean(row.search || row.qty || row.productId)}
                          value={row.productId} onChange={event => updateRow(row.id, "productId", event.target.value)}>
                          <option value="">Select an existing product</option>
                          {products.filter(p => p.id === row.productId || productLookupText(`${p.sku} ${p.name}`).includes(productLookupText(row.search)))
                            .map(p => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
                        </select>
                      </div>
                      <input
                        name="product_qty"
                        type="number"
                        min="1"
                        step="1"
                        required={Boolean(row.productId)}
                        aria-label={`Quantity for row ${index + 1}`}
                        className="input"
                        placeholder="Qty"
                        value={row.qty}
                        onChange={(event) => updateRow(row.id, "qty", event.target.value)}
                      />
                      <button
                        type="button"
                        className="rounded-md border border-[#d1d5db] px-2 py-1 text-xs font-semibold text-[#374151] hover:bg-[#f3f4f6]"
                        onClick={() => removeRow(row.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <p className="mt-1 text-xs text-[#64748b]">Search, select an existing product, then enter quantity. New products must be added on Inventory first; typing here never creates one.</p>
              </div>

              <div>
                <label className="label" htmlFor="notes">Notes</label>
                <textarea id="notes" name="notes" rows={4} className="textarea" />
              </div>

              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
                <button type="submit" className="btn-primary">Save Container</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
