"use client";

import { useState } from "react";
import { completeOrderShipmentAction } from "../actions";

type ShipmentLine = { id: string; sku: string; label: string; remainingQty: number; fulfilledQty: number };

export function CreateShipmentForm({ orderId, lines }: { orderId: string; lines: ShipmentLine[] }) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState(false);

  if (!selecting) return <button type="button" className="btn-primary" onClick={() => setSelecting(true)}>Create Shipment</button>;

  const selectedLines = lines.filter((line) => selected.includes(line.id));
  function toggle(line: ShipmentLine) {
    setSelected((current) => current.includes(line.id) ? current.filter((id) => id !== line.id) : [...current, line.id]);
    setQuantities((current) => ({ ...current, [line.id]: current[line.id] ?? Math.min(1, line.remainingQty) }));
  }

  if (!editing) return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-[#dbe3ee] bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4"><div><h3 className="text-lg font-semibold text-[#111827]">Create Shipment</h3><p className="mt-1 text-sm text-[#64748b]">Select the products and quantities in this shipment.</p></div><button type="button" className="btn-secondary" onClick={() => setSelecting(false)}>Cancel</button></div>
        <div className="mt-4 max-h-[55vh] space-y-2 overflow-y-auto">{lines.map((line) => <label key={line.id} className={`flex items-center gap-3 rounded-lg border p-3 text-sm ${line.remainingQty > 0 ? "border-[#e2e8f0] bg-[#f8fafc]" : "border-[#f1f5f9] bg-white opacity-60"}`}><input type="checkbox" disabled={line.remainingQty <= 0} checked={selected.includes(line.id)} onChange={() => toggle(line)} /><span className="min-w-0 flex-1"><span className="font-semibold">{line.sku}</span><span className="ml-2 text-[#64748b]">{line.label}</span></span><span className="text-xs text-[#64748b]">{line.fulfilledQty > 0 ? `${line.fulfilledQty} fulfilled · ` : ""}{line.remainingQty} remaining</span>{selected.includes(line.id) ? <input name={`quantity_${line.id}`} type="number" min="1" max={line.remainingQty} value={quantities[line.id] ?? 1} onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: Number(event.target.value) }))} className="w-20 rounded border border-[#cbd5e1] px-2 py-1" /> : null}</label>)}</div>
        <div className="mt-4 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setSelecting(false)}>Cancel</button><button type="button" className="btn-primary" disabled={selected.length === 0} onClick={() => setEditing(true)}>Continue with {selected.length} item{selected.length === 1 ? "" : "s"}</button></div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-[#dbe3ee] bg-white p-5 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><h3 className="text-lg font-semibold text-[#111827]">Complete Shipment</h3><p className="mt-1 text-sm text-[#64748b]">Items are not fulfilled until this form succeeds.</p></div><button type="button" className="btn-secondary" onClick={() => setSelecting(false)}>Cancel</button></div><form action={completeOrderShipmentAction} className="mt-4 grid gap-3"><input type="hidden" name="orderId" value={orderId} /><input type="hidden" name="idempotency_key" value={`${orderId}:${selectedLines.map((line) => `${line.id}-${quantities[line.id]}`).join(",")}`} />{selectedLines.map((line) => <span key={line.id}><input type="hidden" name="selected_line_id" value={line.id} /><input type="hidden" name={`quantity_${line.id}`} value={quantities[line.id] ?? 1} /></span>)}<p className="text-sm font-semibold text-[#334155]">Items in this shipment</p><ul className="list-disc pl-5 text-sm text-[#475569]">{selectedLines.map((line) => <li key={line.id}>{line.sku} × {quantities[line.id] ?? 1}</li>)}</ul><label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Ship date<input name="shipment_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className="input mt-1" required /></label><label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Carrier<input name="carrier" className="input mt-1" placeholder="UPS, FedEx, Freight, Customer Carrier, Other" /></label><label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Tracking / PRO number<input name="tracking_number" className="input mt-1" /></label><label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Notes<textarea name="shipment_notes" rows={3} className="textarea mt-1" /></label><div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEditing(false)}>Back</button><button type="submit" className="btn-primary">Complete Shipment</button></div></form></div>
    </div>
  );
}
