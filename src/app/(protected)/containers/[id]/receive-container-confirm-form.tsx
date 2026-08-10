"use client";

import { acceptContainerToWarehouseAction } from "../actions";

type ReceiveContainerConfirmFormProps = {
  containerId: string;
  containerNumber: string;
  eligibleLineCount: number;
  waitingLineCount: number;
  requireFullReceiptConfirmation: boolean;
};

export function ReceiveContainerConfirmForm({
  containerId,
  containerNumber,
  eligibleLineCount,
  waitingLineCount,
  requireFullReceiptConfirmation,
}: ReceiveContainerConfirmFormProps) {
  const confirmMessage = `This will mark Container ${containerNumber} as Received and move ${eligibleLineCount} eligible order lines to In Warehouse. ${waitingLineCount} other lines will remain waiting.`;

  return (
    <form
      action={acceptContainerToWarehouseAction}
      onSubmit={(event) => {
        if (!window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
      className="space-y-2"
    >
      <input type="hidden" name="container_id" value={containerId} />
      <input type="hidden" name="container_number" value={containerNumber} />

      {requireFullReceiptConfirmation ? (
        <label className="flex items-start gap-2 text-xs text-[#475569]">
          <input
            type="checkbox"
            name="full_receipt_confirmed"
            value="yes"
            required
            className="mt-0.5"
          />
          <span>I confirm this is a full container receipt and missing received quantities should use full container quantities.</span>
        </label>
      ) : (
        <input type="hidden" name="full_receipt_confirmed" value="yes" />
      )}

      <button type="submit" className="btn-primary">Receive Container &amp; Update Orders</button>
    </form>
  );
}
