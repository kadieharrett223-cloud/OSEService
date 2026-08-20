"use client";

import { useState } from "react";
import { updateOrderLineAssignmentAction } from "../actions";

type FulfillmentSource = "WAREHOUSE" | "CONTAINER" | "DROPSHIP" | "OTHER";

export function SourceAssignmentForm({
  orderId,
  lineId,
  remainingQty,
  qtyAssignedDefault,
  defaultSource,
  supplier,
  reference,
  tracking,
  notes,
  containers,
}: {
  orderId: string;
  lineId: string;
  remainingQty: number;
  qtyAssignedDefault: number;
  defaultSource: FulfillmentSource;
  supplier: string;
  reference: string;
  tracking: string;
  notes: string;
  containers: Array<{ id: string; container_number: string | null; lifecycle_status: string | null; eta_confirmed_date: string | null; eta_estimated_date: string | null }>;
}) {
  const [source, setSource] = useState<FulfillmentSource>(defaultSource);
  const today = new Date();

  return (
    <form action={updateOrderLineAssignmentAction} className="mt-4 grid gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="lineId" value={lineId} />
      <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Fulfillment Source</label>
      <select name="assignment_source" className="select text-sm" value={source} onChange={(event) => setSource(event.target.value as FulfillmentSource)}>
        <option value="WAREHOUSE">Warehouse</option>
        <option value="CONTAINER">Container</option>
        <option value="DROPSHIP">Dropship</option>
        <option value="OTHER">Other</option>
      </select>

      {source === "WAREHOUSE" || source === "CONTAINER" ? (
        <>
          {source === "CONTAINER" ? (
            <>
              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Container</label>
              <select name="assignment_container_id" className="select text-sm" required>
                <option value="">Select incoming container</option>
                {containers.map((container) => {
                  const etaRaw = container.eta_confirmed_date ?? container.eta_estimated_date;
                  const eta = etaRaw ? new Date(etaRaw) : null;
                  const etaLabel = eta && !Number.isNaN(eta.getTime())
                    ? eta.toLocaleDateString("en-US", { month: "short", day: "numeric", year: today.getFullYear() === eta.getFullYear() ? undefined : "numeric" })
                    : "Pending";
                  return (
                    <option key={container.id} value={container.id}>
                      {(container.container_number ?? "Container")} · {String(container.lifecycle_status ?? "Pending").replace(/_/g, " ")} · ETA {etaLabel}
                    </option>
                  );
                })}
              </select>
              <p className="text-xs text-[#64748b]">Container assignments reserve incoming supply only. No ON_FLOOR inventory is deducted until receiving.</p>
            </>
          ) : null}
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Qty reserved</label>
          <input name="qty_assigned" type="number" min="1" max={Math.max(1, remainingQty || 1)} defaultValue={qtyAssignedDefault} className="input" />
        </>
      ) : null}

      {source === "DROPSHIP" ? (
        <>
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Supplier / Vendor</label>
          <input name="fulfillment_supplier" className="input" defaultValue={supplier} placeholder="Supplier/vendor" required />
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">PO / Reference</label>
          <input name="fulfillment_reference" className="input" defaultValue={reference} />
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Tracking</label>
          <input name="fulfillment_tracking" className="input" defaultValue={tracking} />
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Notes</label>
          <textarea name="fulfillment_notes" className="textarea" defaultValue={notes} />
          <p className="text-xs text-[#64748b]">Dropship completion does not deduct ON_FLOOR inventory or move container quantities.</p>
        </>
      ) : null}

      {source === "OTHER" ? (
        <>
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Required explanation</label>
          <textarea name="fulfillment_notes" className="textarea" defaultValue={notes} placeholder="Explain the verified non-inventory fulfillment evidence" required />
          <p className="text-xs text-[#64748b]">Other fulfillment does not deduct ON_FLOOR inventory or move container quantities.</p>
        </>
      ) : null}

      <button className="btn-secondary" type="submit" disabled={remainingQty <= 0}>Save Assignment</button>
    </form>
  );
}
