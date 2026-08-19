"use client";

import { useState } from "react";
import { editOrderShipmentAction } from "../actions";

type EditableLine = {
  id: string;
  sku: string;
  productName: string | null;
  currentQty: number;
  maxQty: number;
};

export function ShipmentEditForm({
  orderId,
  shipmentId,
  shippedAt,
  carrier,
  trackingNumber,
  notes,
  lines,
  onCancel,
}: {
  orderId: string;
  shipmentId: string;
  shippedAt: string;
  carrier: string | null;
  trackingNumber: string | null;
  notes: string | null;
  lines: EditableLine[];
  onCancel: () => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, string>>(
    Object.fromEntries(lines.map((line) => [line.id, line.currentQty > 0 ? String(line.currentQty) : ""])),
  );
  const [selected, setSelected] = useState<Record<string, boolean>>(
    Object.fromEntries(lines.map((line) => [line.id, line.currentQty > 0])),
  );

  return (
    <form action={editOrderShipmentAction} className="mt-3 rounded-lg border border-[#bfdbfe] bg-[#f8fbff] p-3">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="shipment_id" value={shipmentId} />
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs font-semibold text-[#64748b]">Ship date
          <input type="date" name="shipment_date" defaultValue={shippedAt.slice(0, 10)} className="input mt-1" />
        </label>
        <label className="text-xs font-semibold text-[#64748b]">Carrier
          <input name="carrier" defaultValue={carrier ?? ""} className="input mt-1" />
        </label>
        <label className="text-xs font-semibold text-[#64748b]">Tracking / PRO number
          <input name="tracking_number" defaultValue={trackingNumber ?? ""} className="input mt-1" />
        </label>
        <label className="text-xs font-semibold text-[#64748b]">Notes
          <textarea name="shipment_notes" defaultValue={notes ?? ""} rows={2} className="textarea mt-1" />
        </label>
      </div>

      <p className="mt-4 text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Items in this shipment</p>
      <div className="mt-2 divide-y divide-[#dbeafe] rounded-lg border border-[#dbeafe] bg-white">
        {lines.map((line) => (
          <label key={line.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <input
              type="checkbox"
              name="selected_line_id"
              value={line.id}
              checked={Boolean(selected[line.id])}
              onChange={(event) => setSelected((current) => ({ ...current, [line.id]: event.target.checked }))}
              aria-label={`Include ${line.sku} in shipment`}
            />
            <span className="min-w-0 flex-1">
              <span className="font-semibold text-[#111827]">{line.sku}</span>
              {line.productName ? <span className="ml-2 text-xs text-[#64748b]">{line.productName}</span> : null}
            </span>
            <input
              type="number"
              name={`quantity_${line.id}`}
              min={selected[line.id] ? 1 : 0}
              max={line.maxQty}
              value={quantities[line.id] ?? ""}
              onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
              disabled={!selected[line.id]}
              className="w-20 rounded border border-[#cbd5e1] px-2 py-1 text-xs disabled:bg-[#f1f5f9]"
              aria-label={`Quantity of ${line.sku}`}
            />
            <span className="text-xs text-[#64748b]">max {line.maxQty}</span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="btn-secondary text-xs" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary text-xs">Save Shipment Changes</button>
      </div>
    </form>
  );
}
