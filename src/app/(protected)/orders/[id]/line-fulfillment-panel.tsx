"use client";

import { useState } from "react";
import { completeNonWarehouseFulfillmentAction, markOrderLinesPickedUpAction } from "../actions";

type Attachment = {
  id: string;
  file_name: string | null;
  document_type?: string | null;
  is_restricted?: boolean | null;
};

type FulfillmentEntry = {
  id: string;
  fulfilled_qty: number | null;
  fulfilled_at: string;
  carrier: string | null;
  tracking_number: string | null;
  fulfillment_type?: "SHIPMENT" | "PICKUP" | null;
};

type FulfillmentSource = "WAREHOUSE" | "DROPSHIP" | "OTHER";

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function LineFulfillmentPanel({
  orderId,
  lineId,
  sku,
  remainingQty,
  queuePosition,
  fulfillmentMethod,
  fulfillmentSource,
  supplier,
  reference,
  tracking,
  notes,
  attachments,
  history,
}: {
  orderId: string;
  lineId: string;
  sku: string;
  remainingQty: number;
  queuePosition: number | null;
  fulfillmentMethod: "SHIP" | "WILL_CALL";
  fulfillmentSource: FulfillmentSource;
  supplier: string;
  reference: string;
  tracking: string;
  notes: string;
  attachments: Attachment[];
  history: FulfillmentEntry[];
}) {
  const [mode, setMode] = useState<"SHIP" | "PICKUP">(fulfillmentMethod === "WILL_CALL" ? "PICKUP" : "SHIP");
  const pickupReceipts = attachments.filter((item) => item.document_type === "PICKUP_RECEIPT");
  const driverLicenses = attachments.filter((item) => item.document_type === "DRIVERS_LICENSE" && item.is_restricted);
  const isDropship = fulfillmentSource === "DROPSHIP";
  const isOther = fulfillmentSource === "OTHER";

  return (
    <div className="rounded-xl border border-[#dbe3ee] bg-white p-4 xl:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#eef2f7] pb-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Fulfillment</p>
          <h3 className="mt-1 text-lg font-semibold text-[#111827]">{sku} · Qty {remainingQty}</h3>
          <p className="mt-1 text-sm text-[#475569]">Ordered line remaining: {remainingQty} · Customer queue: {queuePosition != null ? `#${queuePosition}` : "Not queued"}</p>
        </div>
        {isDropship || isOther ? null : <div className="flex rounded-lg border border-[#dbe3ee] bg-[#f8fafc] p-1">
          <button type="button" onClick={() => setMode("SHIP")} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${mode === "SHIP" ? "bg-white text-[#111827] shadow-sm" : "text-[#64748b]"}`}>Ship</button>
          <button type="button" onClick={() => setMode("PICKUP")} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${mode === "PICKUP" ? "bg-white text-[#111827] shadow-sm" : "text-[#64748b]"}`}>Will Call / Pickup</button>
        </div>}
      </div>

      {isDropship || isOther ? (
        <form action={completeNonWarehouseFulfillmentAction} className="mt-4 grid gap-3 md:grid-cols-2">
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="lineId" value={lineId} />
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Qty<input name="fulfill_qty" type="number" min="1" max={remainingQty} defaultValue={remainingQty > 0 ? 1 : 0} className="input mt-1" required /></label>
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Completion date<input name="fulfilled_date" type="date" defaultValue={today()} className="input mt-1" required /></label>
          {isDropship ? (
            <>
              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Supplier / Vendor<input name="fulfillment_supplier" className="input mt-1" defaultValue={supplier} required /></label>
              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">PO / Reference<input name="fulfillment_reference" className="input mt-1" defaultValue={reference} /></label>
              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Tracking<input name="fulfillment_tracking" className="input mt-1" defaultValue={tracking} /></label>
              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Notes<input name="fulfillment_notes" className="input mt-1" defaultValue={notes} /></label>
            </>
          ) : (
            <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b] md:col-span-2">Required explanation<textarea name="fulfillment_notes" className="textarea mt-1" defaultValue={notes} required /></label>
          )}
          <button type="submit" className="btn-primary md:col-span-2" disabled={remainingQty <= 0}>{isDropship ? "Complete Dropship" : "Complete Other Fulfillment"}</button>
        </form>
      ) : mode === "SHIP" ? (
        <p className="mt-4 rounded-lg border border-[#dbe5f0] bg-[#f8fbff] p-3 text-sm text-[#334155]">Create physical shipments from the <strong>Create Shipment</strong> button above Items. You can include multiple products and partial quantities in one shipment.</p>
      ) : (
        <form action={markOrderLinesPickedUpAction} className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="line_id" value={lineId} />
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Qty<input name={`pickup_qty_${lineId}`} type="number" min="1" max={remainingQty} defaultValue={remainingQty > 0 ? 1 : 0} className="input mt-1" required /></label>
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Pickup date<input name="pickup_date" type="date" defaultValue={today()} className="input mt-1" required /></label>
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b] md:col-span-2">Picked up by<input name="pickup_person_name" className="input mt-1" placeholder="Full name" required /></label>
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Acknowledgment<select name="acknowledgment_document_id" className="input mt-1" required><option value="">Select document</option>{pickupReceipts.map((item) => <option key={item.id} value={item.id}>{item.file_name}</option>)}</select></label>
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">ID verified<select name="drivers_license_document_id" className="input mt-1" required><option value="">Select ID document</option>{driverLicenses.map((item) => <option key={item.id} value={item.id}>{item.file_name}</option>)}</select></label>
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b] md:col-span-2">Notes<input name="pickup_notes" className="input mt-1" placeholder="Optional pickup notes" /></label>
          {pickupReceipts.length === 0 || driverLicenses.length === 0 ? <p className="text-xs text-[#92400e] md:col-span-2 xl:col-span-4">Upload a pickup acknowledgment and restricted ID document in Documents before completing pickup.</p> : null}
          <button type="submit" className="btn-primary md:col-span-2 xl:col-span-4" disabled={remainingQty <= 0 || pickupReceipts.length === 0 || driverLicenses.length === 0}>Mark Picked Up</button>
        </form>
      )}

      <div className="mt-4 border-t border-[#eef2f7] pt-3">
        <p className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Fulfillment history</p>
        {history.length === 0 ? <p className="mt-2 text-sm text-[#64748b]">No fulfillment recorded yet.</p> : <div className="mt-2 space-y-2">{history.map((entry) => <div key={entry.id} className="rounded-lg border border-[#eef2f7] bg-[#fafbfc] p-2 text-xs text-[#475569]"><p>{new Date(entry.fulfilled_at).toLocaleString()} · Qty {entry.fulfilled_qty ?? 0} · {entry.fulfillment_type ?? "SHIPMENT"}</p><p>{entry.carrier ?? ""}{entry.tracking_number ? ` · ${entry.tracking_number}` : ""}</p></div>)}</div>}
      </div>
    </div>
  );
}
