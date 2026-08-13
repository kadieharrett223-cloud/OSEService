"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type CustomerQueueItem = {
  position: string;
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
};

export function CustomerDemandDropdown({
  productName,
  sku,
  openQuantity,
  customerQueue,
}: CustomerDemandDropdownProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function toggleDropdown() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const panelWidth = Math.min(760, window.innerWidth - 32);
      const left = Math.min(
        Math.max(16, rect.right - panelWidth),
        window.innerWidth - panelWidth - 16,
      );
      setPosition({
        top: Math.min(rect.bottom + 8, window.innerHeight - 24),
        left,
      });
    }
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
        <div
          ref={panelRef}
          className="fixed z-[60] w-[min(760px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] rounded-xl border border-[#dbe3ee] bg-white p-4 text-left shadow-2xl ring-1 ring-[#0f172a]/10"
          style={{ top: position.top, left: position.left }}
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
          </div>

          {customerQueue.length === 0 ? (
            <p className="px-2 py-2 text-xs text-[#64748b]">No approved open queue for this SKU.</p>
          ) : (
            <div className="mt-3 max-h-[min(420px,60vh)] space-y-2 overflow-y-auto pr-1">
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
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
