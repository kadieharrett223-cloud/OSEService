"use client";

import { useState } from "react";
import { shipSelectedOrderLinesAction } from "../actions";

type ShipItem = {
  id: string;
  label: string;
  sku: string;
  remainingQty: number;
};

export function ShipItemsForm({ orderId, items }: { orderId: string; items: ShipItem[] }) {
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <>
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>Ship Items</button>
      {open ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-xl border border-[#dbe3ee] bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-[#111827]">Ship Items</h3>
                <p className="mt-1 text-sm text-[#64748b]">Select mapped inventory items for this shipment.</p>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Close</button>
            </div>
            <form action={shipSelectedOrderLinesAction} className="mt-4 grid gap-3">
              {items.map((item) => (
                <label key={item.id} className="flex items-center gap-3 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-3 text-sm">
                  <input type="checkbox" name="line_id" value={item.id} defaultChecked />
                  <span className="min-w-0 flex-1"><span className="font-semibold text-[#1e293b]">{item.sku}</span><span className="ml-2 text-[#64748b]">{item.label}</span></span>
                  <span className="font-semibold text-[#15803d]">Qty {item.remainingQty}</span>
                </label>
              ))}
              <input type="hidden" name="orderId" value={orderId} />
              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Tracking number</label>
              <input name="tracking_number" className="input" required />
              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Carrier</label>
              <input name="carrier" className="input" />
              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Shipment date</label>
              <input name="shipment_date" type="date" className="input" required />
              <button type="submit" className="btn-primary">Create Shipment</button>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}