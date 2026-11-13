"use client";

import { useState } from "react";
import { updateOrderLineAssignmentAction } from "../actions";
import { AssignmentSubmitButton } from "./assignment-submit-button";
import { hasMappingSourceProblem, MAPPING_SOURCE_ERROR } from "@/lib/orders/other-source-safety";

type FulfillmentSource = "WAREHOUSE" | "CONTAINER" | "DROPSHIP" | "OTHER" | "CUSTOMER_NOT_READY";

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
  containers: Array<{ id: string; container_number: string | null; lifecycle_status: string | null; eta_confirmed_date: string | null; eta_estimated_date: string | null; available_qty?: number | null }>;
}) {
  const [source, setSource] = useState<FulfillmentSource>(defaultSource);
  const [otherNotes, setOtherNotes] = useState(notes);
  const invalidOther = source === "OTHER" && hasMappingSourceProblem(otherNotes);
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
        <option value="OTHER">Other — no warehouse stock deduction</option>
        <option value="CUSTOMER_NOT_READY">Customer Not Ready</option>
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
                  const availableQty = Math.max(0, Number(container.available_qty ?? 0));
                  const etaLabel = eta && !Number.isNaN(eta.getTime())
                    ? eta.toLocaleDateString("en-US", { month: "short", day: "numeric", year: today.getFullYear() === eta.getFullYear() ? undefined : "numeric" })
                    : "Pending";
                  return (
                    <option key={container.id} value={container.id}>
                      {(container.container_number ?? "Container")} · {availableQty} available · ETA {etaLabel}
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
          <textarea name="fulfillment_notes" className="textarea" value={otherNotes} onChange={(event) => setOtherNotes(event.target.value)} placeholder="Identify the actual non-warehouse source and supporting reference" required />
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900">Other will NOT deduct warehouse stock. It also removes this open item from active Customer Lists. Use Warehouse or Container for goods supplied from our inventory.</p>
          {invalidOther ? <p role="alert" className="text-sm font-semibold text-red-700">{MAPPING_SOURCE_ERROR}</p> : null}
          <label className="flex items-start gap-2 text-sm text-[#334155]"><input type="checkbox" name="acknowledge_no_stock" value="yes" required className="mt-1" />I verified this item does not use warehouse stock and should be excluded from active Customer Lists.</label>
        </>
      ) : null}

      {source === "CUSTOMER_NOT_READY" ? <>
        <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Notes (optional)
          <textarea name="fulfillment_notes" className="textarea mt-1" defaultValue={notes} placeholder="Customer timing or follow-up instructions" />
        </label>
        <p className="text-xs text-[#64748b]">Keeps this item owed but removes it from active Customer Lists and releases its reservation. Does not change physical stock or mark anything shipped. Change the source back when the customer is ready; original queue priority is retained.</p>
      </> : null}

      <AssignmentSubmitButton label="Save Assignment" disabled={remainingQty <= 0 || invalidOther} />
    </form>
  );
}
