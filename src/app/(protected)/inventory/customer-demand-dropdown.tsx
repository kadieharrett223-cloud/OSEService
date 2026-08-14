"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { moveCustomerQueuePositionAction } from "@/app/(protected)/inventory/actions";

type CustomerQueueItem = {
  position: string;
  lineId: string;
  invoice: string;
  customer: string;
  qty: number;
  priority: string;
  assignedTo: string;
  expectedAvailability: string;
  status: string;
  orderId: string;
};

type CustomerDemandDropdownProps = {
  productName: string;
  sku: string;
  openQuantity: string;
  customerQueue: CustomerQueueItem[];
  adminMode?: boolean;
};

export function CustomerDemandDropdown({
  productName,
  sku,
  openQuantity,
  customerQueue,
  adminMode = false,
}: CustomerDemandDropdownProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function toggleDropdown() {
    setOpen((current) => !current);
  }

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="text-left text-sm font-semibold text-[#2563eb] hover:underline"
        aria-expanded={open}
        onClick={toggleDropdown}
      >
        Customer List ({customerQueue.length})
      </button>

      {open ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 sm:p-6">
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            className="flex max-h-[90vh] w-full max-w-5xl flex-col rounded-xl border border-[#dbe3ee] bg-white p-5 text-left shadow-2xl"
          >
          <div className="flex items-start justify-between gap-4 border-b border-[#e2e8f0] pb-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Open customer demand</p>
              <h3 className="mt-1 line-clamp-2 max-w-[480px] break-words text-base font-semibold leading-5 text-[#0f172a]" title={productName}>{productName}</h3>
              <p className="mt-1 text-xs text-[#64748b]">SKU {sku} · {customerQueue.length} customer{customerQueue.length === 1 ? "" : "s"}</p>
            </div>
            <div className="shrink-0 text-right text-xs text-[#64748b]">
              <p>Open quantity</p>
              <p className="mt-1 text-lg font-semibold text-[#0f172a]">{openQuantity}</p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close customer list"
              className="shrink-0 rounded-md border border-[#d1d5db] px-2.5 py-1 text-xs font-semibold text-[#374151] transition hover:bg-[#f9fafb]"
            >
              Close
            </button>
          </div>

          {customerQueue.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[#64748b]">No approved open queue for this SKU.</p>
          ) : (
            <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
              {customerQueue.map((item, index) => (
                <div key={`${item.orderId}-${item.invoice}-${index}`} className="grid gap-3 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-3 text-xs sm:grid-cols-[minmax(0,1.4fr)_minmax(150px,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-[#1e293b]">{item.customer}</div>
                    <div className="mt-1 truncate text-[#64748b]">Invoice {item.invoice} · Queue position {item.position}</div>
                  </div>
                  <div className="text-[#475569]">
                    <div>Qty <span className="font-semibold text-[#1e293b]">{item.qty}</span> · {item.priority}</div>
                    <div className="mt-1 truncate text-[#64748b]">{item.assignedTo} · {item.status}</div>
                    <div className="mt-1 truncate font-medium text-[#475569]">{item.expectedAvailability}</div>
                  </div>
                  {item.orderId ? <Link href={`/orders/${item.orderId}`} className="inline-flex whitespace-nowrap rounded-md border border-[#bfdbfe] bg-white px-2.5 py-1.5 font-semibold text-[#1d4ed8] hover:border-[#93c5fd] hover:bg-[#eff6ff]">View Invoice</Link> : <span>—</span>}
                  {adminMode && item.lineId ? (
                    <form action={moveCustomerQueuePositionAction} className="flex flex-wrap items-center gap-2 sm:col-span-3">
                      <input type="hidden" name="line_id" value={item.lineId} />
                      <label className="text-[#64748b]" htmlFor={`pos-${item.lineId}`}>Move to</label>
                      <input
                        id={`pos-${item.lineId}`}
                        name="queue_position"
                        type="number"
                        min="1"
                        step="1"
                        defaultValue={item.position}
                        className="w-20 rounded-md border border-[#cbd5e1] px-2 py-1"
                      />
                      <input
                        name="queue_position_reason"
                        placeholder="Reason"
                        required
                        className="min-w-[160px] flex-1 rounded-md border border-[#cbd5e1] px-2 py-1"
                      />
                      <button type="submit" className="rounded-md bg-[#111827] px-3 py-1 font-semibold text-white transition hover:bg-[#1f2937]">
                        Move
                      </button>
                    </form>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          </div>
        </div>
      ) : null}
    </>
  );
}
