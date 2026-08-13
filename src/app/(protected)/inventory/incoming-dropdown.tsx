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
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function toggleDropdown() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const panelWidth = Math.min(520, window.innerWidth - 32);
      setPosition({
        top: Math.min(rect.bottom + 8, window.innerHeight - 24),
        left: Math.min(Math.max(16, rect.right - panelWidth), window.innerWidth - panelWidth - 16),
      });
    }
    setOpen((value) => !value);
  }

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div>
      <button ref={triggerRef} type="button" className="text-left font-semibold text-[#2563eb] hover:underline" onClick={toggleDropdown} aria-expanded={open}>
        {total}
      </button>
      {open ? (
        <div ref={panelRef} className="fixed z-[60] w-[min(520px,calc(100vw-2rem))] rounded-xl border border-[#dbe3ee] bg-white p-4 text-left shadow-2xl ring-1 ring-[#0f172a]/10" style={{ top: position.top, left: position.left }}>
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
            <div className="mt-3 space-y-2">
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
      ) : null}
    </div>
  );
}
