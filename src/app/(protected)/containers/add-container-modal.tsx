"use client";

import { useState } from "react";

type AddContainerModalProps = {
  createAction: (formData: FormData) => void | Promise<void>;
};

export function AddContainerModal({ createAction }: AddContainerModalProps) {
  const [open, setOpen] = useState(false);

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
                <label className="label" htmlFor="products">Products / Quantities</label>
                <textarea id="products" name="products" rows={6} className="textarea" placeholder="SKU|Qty&#10;ABC-100|10&#10;XYZ-200|4" />
                <p className="mt-1 text-xs text-[#64748b]">Enter one product per line as SKU|Qty.</p>
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
