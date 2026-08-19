"use client";

import { useState } from "react";
import { ShipmentEditForm } from "./shipment-edit-form";

type HistoryLine = {
  quantity: number | null;
  shipping_order_line_id: string;
  shipping_order_lines?: { products?: { sku: string | null; canonical_name: string | null } | null } | null;
};

type EditableLine = {
  id: string;
  sku: string;
  productName: string | null;
  currentQty: number;
  maxQty: number;
};

export function ShipmentHistoryCard({
  orderId,
  shipment,
  editableLines,
}: {
  orderId: string;
  shipment: {
    id: string;
    shipment_number: string;
    shipped_at: string;
    carrier: string | null;
    tracking_number: string | null;
    notes: string | null;
    creator?: { full_name: string | null } | null;
    document_count?: number;
    lines?: HistoryLine[];
  };
  editableLines: EditableLine[];
}) {
  const [editing, setEditing] = useState(false);
  const historical = shipment.id.startsWith("historical-");

  return (
    <div className="rounded-xl border border-[#e2e8f0] bg-[#fafbfc] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-[#111827]">{shipment.shipment_number}</h3>
          <p className="mt-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#1b7a43]">Shipped {new Date(shipment.shipped_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</p>
          {shipment.creator?.full_name ? <p className="mt-1 text-xs text-[#64748b]">Recorded by {shipment.creator.full_name}</p> : null}
        </div>
        <div className="text-right text-sm">
          <p className="font-semibold text-[#334155]">{shipment.carrier ?? "Carrier pending"}</p>
          <p className="mt-0.5 text-xs text-[#64748b]">{shipment.tracking_number ? `Tracking ${shipment.tracking_number}` : "No tracking number"}</p>
        </div>
      </div>

      <p className="mt-3 text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Items in this shipment</p>
      {historical && (!shipment.lines || shipment.lines.length === 0) ? (
        <p className="mt-1 text-sm text-[#64748b]">Historical shipment — item detail unavailable</p>
      ) : (
        <ul className="mt-1 divide-y divide-[#eef2f7] text-sm text-[#334155]">
          {(shipment.lines ?? []).map((line, index) => (
            <li key={`${line.shipping_order_line_id}-${index}`} className="flex items-center justify-between py-1.5">
              <span>
                <span className="font-semibold">{line.shipping_order_lines?.products?.sku ?? "Item"}</span>
                {line.shipping_order_lines?.products?.canonical_name ? <span className="ml-2 text-[#64748b]">{line.shipping_order_lines.products.canonical_name}</span> : null}
              </span>
              <span className="font-semibold">× {line.quantity ?? 0}</span>
            </li>
          ))}
        </ul>
      )}

      {shipment.notes ? <div className="mt-3 rounded-lg border border-[#e5e7eb] bg-white p-2.5"><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Notes</p><p className="mt-1 text-sm text-[#334155]">{shipment.notes}</p></div> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {shipment.tracking_number ? <a href={`https://www.google.com/search?q=${encodeURIComponent(shipment.tracking_number)}`} target="_blank" rel="noreferrer" className="btn-secondary text-xs">View Tracking</a> : null}
        {shipment.document_count ? <a href="#documents" className="btn-secondary text-xs">Documents: {shipment.document_count}</a> : null}
        {!historical ? <button type="button" className="btn-secondary text-xs" onClick={() => setEditing((value) => !value)}>{editing ? "Close Editor" : "Edit Shipment"}</button> : null}
      </div>
      {editing ? <ShipmentEditForm orderId={orderId} shipmentId={shipment.id} shippedAt={shipment.shipped_at} carrier={shipment.carrier} trackingNumber={shipment.tracking_number} notes={shipment.notes} lines={editableLines} onCancel={() => setEditing(false)} /> : null}
    </div>
  );
}
