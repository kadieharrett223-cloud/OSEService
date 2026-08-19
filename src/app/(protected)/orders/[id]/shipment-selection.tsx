"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { completeOrderShipmentAction, markOrderLinesPickedUpAction } from "../actions";

type SelectionLine = { id: string; sku: string; remainingQty: number; defaultQty: number; inStock: number };
type SelectedLine = SelectionLine & { quantity: number };
type ContextValue = { active: boolean; selected: SelectedLine[]; start: () => void; cancel: () => void; toggle: (line: SelectionLine) => void; setQuantity: (id: string, quantity: number) => void };
const SelectionContext = createContext<ContextValue | null>(null);

export function ShipmentSelectionProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState(false);
  const [selectedMap, setSelectedMap] = useState<Record<string, SelectedLine>>({});
  const selected = useMemo(() => Object.values(selectedMap), [selectedMap]);
  function start() { setActive(true); setSelectedMap({}); }
  function cancel() { setActive(false); setSelectedMap({}); }
  function toggle(line: SelectionLine) {
    setSelectedMap((current) => {
      if (current[line.id]) { const next = { ...current }; delete next[line.id]; return next; }
      return { ...current, [line.id]: { ...line, quantity: line.defaultQty } };
    });
  }
  function setQuantity(id: string, quantity: number) { setSelectedMap((current) => current[id] ? { ...current, [id]: { ...current[id], quantity: Math.max(1, Math.min(current[id].remainingQty, quantity || 1)) } } : current); }
  return <SelectionContext.Provider value={{ active, selected, start, cancel, toggle, setQuantity }}>{children}</SelectionContext.Provider>;
}

function useSelection() { const value = useContext(SelectionContext); if (!value) throw new Error("Shipment selection controls must be inside ShipmentSelectionProvider"); return value; }

export function ShipmentSelectionButton({ pickupMode = false }: { pickupMode?: boolean }) {
  const { active, start } = useSelection();
  return active ? <span className="rounded-full bg-[#fff7e6] px-3 py-1.5 text-xs font-semibold text-[#92400e]">Creating {pickupMode ? "Pickup" : "Shipment"}</span> : <button type="button" className="btn-primary" onClick={start}>{pickupMode ? "Create Pickup" : "Create Shipment"}</button>;
}

export function ShipmentSelectionCheckbox({ line }: { line: SelectionLine }) {
  const { active, selected, toggle, setQuantity } = useSelection();
  if (!active || line.remainingQty <= 0) return null;
  const selectedLine = selected.find((item) => item.id === line.id);
  return <span className="mr-2 inline-flex items-center gap-1 align-middle"><input type="checkbox" checked={Boolean(selectedLine)} onChange={() => toggle(line)} aria-label={`Include ${line.sku} in shipment`} />{selectedLine ? <input type="number" min="1" max={line.remainingQty} value={selectedLine.quantity} onChange={(event) => setQuantity(line.id, Number(event.target.value))} className="w-16 rounded border border-[#cbd5e1] px-1.5 py-1 text-xs" aria-label={`Quantity of ${line.sku}`} /> : null}{line.inStock <= 0 ? <span className="ml-1 text-[11px] font-medium text-[#b45309]">Waiting / not in stock</span> : null}</span>;
}

export function ShipmentSelectionComposer({ orderId, pickupMode = false }: { orderId: string; pickupMode?: boolean }) {
  const { active, selected, cancel } = useSelection();
  if (!active) return null;
  return <div className="mt-4 rounded-xl border border-[#bfdbfe] bg-[#f8fbff] p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold text-[#111827]">{pickupMode ? "Creating Pickup" : "Creating Shipment"}</h3><p className="mt-1 text-sm text-[#475569]">Select the items and quantities included in this {pickupMode ? "pickup" : "shipment"}.</p></div><button type="button" className="btn-secondary" onClick={cancel}>Cancel</button></div>{selected.length === 0 ? <p className="mt-3 text-sm text-[#64748b]">Select at least one remaining line above.</p> : <form action={pickupMode ? markOrderLinesPickedUpAction : completeOrderShipmentAction} className="mt-4 grid gap-3"><input type="hidden" name="orderId" value={orderId} />{!pickupMode ? <input type="hidden" name="idempotency_key" value={`${orderId}:${selected.map((line) => `${line.id}-${line.quantity}`).join(",")}`} /> : null}<p className="text-sm font-semibold text-[#334155]">Selected items</p><ul className="list-disc pl-5 text-sm text-[#475569]">{selected.map((line) => <li key={line.id}>{line.sku} × {line.quantity}</li>)}</ul>{pickupMode ? <><label className="text-xs font-semibold text-[#64748b]">Pickup date<input name="pickup_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className="input mt-1" required /></label><label className="text-xs font-semibold text-[#64748b]">Picked up by<input name="pickup_person_name" className="input mt-1" placeholder="Full name" required /></label><label className="text-xs font-semibold text-[#64748b]">Pickup notes<input name="pickup_notes" className="input mt-1" /></label><label className="text-xs font-semibold text-[#64748b]">Acknowledgment document<input name="acknowledgment_document_id" className="input mt-1" placeholder="Document ID from Documents" required /></label><label className="text-xs font-semibold text-[#64748b]">Restricted ID document<input name="drivers_license_document_id" className="input mt-1" placeholder="Document ID from Documents" required /></label></> : <><label className="text-xs font-semibold text-[#64748b]">Ship date<input name="shipment_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className="input mt-1" required /></label><label className="text-xs font-semibold text-[#64748b]">Carrier<input name="carrier" className="input mt-1" /></label><label className="text-xs font-semibold text-[#64748b]">Tracking / PRO number<input name="tracking_number" className="input mt-1" /></label><label className="text-xs font-semibold text-[#64748b]">Notes<textarea name="shipment_notes" rows={2} className="textarea mt-1" /></label></>}{selected.map((line) => <span key={line.id}><input type="hidden" name={pickupMode ? "line_id" : "selected_line_id"} value={line.id} /><input type="hidden" name={`${pickupMode ? "pickup_qty" : "quantity"}_${line.id}`} value={line.quantity} /></span>)}<button type="submit" className="btn-primary">{pickupMode ? "Create Pickup" : "Create Shipment"}</button></form>}</div>;
}
