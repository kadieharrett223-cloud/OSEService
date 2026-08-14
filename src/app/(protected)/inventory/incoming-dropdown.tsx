"use client";

import { useEffect, useRef, useState } from "react";

type IncomingContainer = {
  containerNumber: string;
  qty: number;
  committed: number;
  available: number;
  eta: string;
  status: string;
};

type IncomingDropdownProps = {
  total: string;
  containers: IncomingContainer[];
};

export function IncomingDropdown({ total, containers }: IncomingDropdownProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function toggleDropdown() {
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
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
    <div>
      <button ref={triggerRef} type="button" className="text-left font-semibold text-[#2563eb] hover:underline" onClick={toggleDropdown} aria-expanded={open}>
        {total}
      </button>
      {open ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 sm:p-6">
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-[#dbe3ee] bg-white p-5 text-left shadow-2xl"
          >
          <div className="flex items-center justify-between border-b border-[#e2e8f0] pb-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Incoming inventory</p>
              <p className="mt-1 text-base font-semibold text-[#0f172a]">{total} units across active containers</p>
            </div>
            <button type="button" className="text-xs font-semibold text-[#64748b] hover:text-[#0f172a]" onClick={() => setOpen(false)}>Close</button>
          </div>
          {containers.length === 0 ? (
            <p className="mt-3 text-xs text-[#64748b]">No active incoming containers.</p>
          ) : (
            <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
              {containers.map((container) => (
                <div key={container.containerNumber} className="grid gap-2 rounded-lg border border-[#e2e8f0] bg-[#f8fafc] p-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                  <div>
                    <div className="font-semibold text-[#1e293b]">Container {container.containerNumber}</div>
                    <div className="mt-1 text-[#64748b]">ETA/Port {container.eta} · {container.status}</div>
                  </div>
                  <div className="text-[#475569]">Qty {container.qty}</div>
                  <div className="text-right text-[#475569]">{container.committed} committed · <span className="font-semibold text-[#1e293b]">{container.available} available</span></div>
                </div>
              ))}
            </div>
          )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
