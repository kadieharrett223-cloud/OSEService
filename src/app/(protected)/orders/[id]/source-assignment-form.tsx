"use client";

import { useState } from "react";
import { updateOrderLineAssignmentAction } from "../actions";

type FulfillmentSource = "WAREHOUSE" | "DROPSHIP" | "OTHER";

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
}) {
  const [source, setSource] = useState<FulfillmentSource>(defaultSource);

  return (
    <form action={updateOrderLineAssignmentAction} className="mt-4 grid gap-2">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="lineId" value={lineId} />
      <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Fulfillment Source</label>
      <select name="assignment_source" className="select text-sm" value={source} onChange={(event) => setSource(event.target.value as FulfillmentSource)}>
        <option value="WAREHOUSE">Warehouse</option>
        <option value="DROPSHIP">Dropship</option>
        <option value="OTHER">Other</option>
      </select>

      {source === "WAREHOUSE" ? (
        <>
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
        </>
      ) : null}

      {source === "OTHER" ? (
        <>
          <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Required explanation</label>
          <textarea name="fulfillment_notes" className="textarea" defaultValue={notes} placeholder="Explain the verified non-inventory fulfillment evidence" required />
        </>
      ) : null}

      <button className="btn-secondary" type="submit" disabled={remainingQty <= 0}>Save Assignment</button>
    </form>
  );
}
