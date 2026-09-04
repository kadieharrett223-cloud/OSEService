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
  approvedQty: number;
  shippedQty: number;
  openQty: number;
  warehouseQty: number;
  waitingQty: number;
  inWarehouse: boolean;
  willCall: boolean;
  priority: string;
  assignedTo: string;
  expectedAvailability: string;
  status: string;
  orderId: string;
  firstPaymentAt: string | null;
  priorityDate: string | null;
  priorityDateSource: "FIRST_PAYMENT" | "INVOICE_DATE" | "INVOICE_NUMBER";
};

type CustomerDemandDropdownProps = {
  productName: string;
  sku: string;
  openQuantity: string;
  customerQueue: CustomerQueueItem[];
  adminMode?: boolean;
};

/** Spreadsheets execute cells beginning with = + - @, so those are neutralised before quoting. */
function toCsvCell(value: string) {
  const raw = String(value ?? "");
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function sortCustomerQueue(items: CustomerQueueItem[]) {
  return [...items].sort((left, right) => {
    const leftPosition = Number.parseInt(left.position, 10);
    const rightPosition = Number.parseInt(right.position, 10);
    const leftSortPosition = Number.isFinite(leftPosition) ? leftPosition : Number.MAX_SAFE_INTEGER;
    const rightSortPosition = Number.isFinite(rightPosition) ? rightPosition : Number.MAX_SAFE_INTEGER;
    return leftSortPosition - rightSortPosition
      || left.invoice.localeCompare(right.invoice)
      || left.lineId.localeCompare(right.lineId);
  });
}

function formatPriorityDate(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function priorityDateLabel(item: Pick<CustomerQueueItem, "firstPaymentAt" | "priorityDate" | "priorityDateSource">) {
  if (item.firstPaymentAt) return `First Paid: ${formatPriorityDate(item.firstPaymentAt)}`;
  if (item.priorityDateSource === "INVOICE_DATE" && item.priorityDate) return `Invoice created: ${formatPriorityDate(item.priorityDate)}`;
  if (item.priorityDateSource === "INVOICE_NUMBER") return "Priority: Invoice number fallback";
  return "Priority unavailable";
}

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
  const sortedCustomerQueue = sortCustomerQueue(customerQueue);

  function toggleDropdown() {
    setOpen((current) => !current);
  }

  function downloadReport() {
    const headers = ["Position", "Customer", "Invoice", "Ordered", "Shipped", "Remaining", "Priority", "Priority Date", "Priority Date Source", "Assignment", "Expected Availability", "Status"];
    const rows = sortedCustomerQueue.map((item) => [
      item.position,
      item.customer,
      item.invoice,
      String(item.approvedQty),
      String(item.shippedQty),
      String(item.openQty),
      item.priority,
      item.priorityDate ?? "",
      item.priorityDateSource === "FIRST_PAYMENT" ? "First payment" : item.priorityDateSource === "INVOICE_DATE" ? "Invoice creation date fallback" : "Invoice number fallback",
      item.assignedTo,
      item.expectedAvailability,
      item.status,
    ]);

    const csv = [
      [`Customer list for ${sku} - ${productName}`],
      [`Open quantity: ${openQuantity}`, `Generated: ${new Date().toLocaleString("en-US")}`],
      [],
      headers,
      ...rows,
    ]
      .map((row) => row.map(toCsvCell).join(","))
      .join("\r\n");

    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `customer-list-${sku.replace(/[^A-Za-z0-9._-]+/g, "-")}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
              onClick={downloadReport}
              disabled={customerQueue.length === 0}
              className="shrink-0 rounded-md border border-[#bfdbfe] bg-white px-2.5 py-1 text-xs font-semibold text-[#1d4ed8] transition hover:border-[#93c5fd] hover:bg-[#eff6ff] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Download report
            </button>
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
              {sortedCustomerQueue.map((item, index) => (
                <div key={`${item.orderId}-${item.invoice}-${index}`} className={`grid gap-3 rounded-lg border p-3 text-xs sm:grid-cols-[minmax(0,1.4fr)_minmax(150px,1fr)_auto] sm:items-center ${item.inWarehouse ? "border-[#93c5fd] bg-[#eff6ff]" : item.willCall ? "border-[#f5c26b] bg-[#fffbeb]" : "border-[#e2e8f0] bg-[#f8fafc]"}`}>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-[#1e293b]">{item.customer}</div>
                    <div className="mt-1 truncate text-[#64748b]">Invoice {item.invoice} · Queue position {item.position}</div>
                    <div className="mt-1 text-[#64748b]">{priorityDateLabel(item)}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {item.inWarehouse ? <span className="rounded-full bg-[#dbeafe] px-2 py-0.5 text-[10px] font-bold tracking-[0.06em] text-[#1d4ed8]">IN WAREHOUSE</span> : null}
                      {item.willCall ? <span className="rounded-full bg-[#fef3c7] px-2 py-0.5 text-[10px] font-bold tracking-[0.06em] text-[#92400e]">WILL CALL</span> : null}
                    </div>
                  </div>
                  <div className="text-[#475569]">
                    {item.shippedQty > 0 ? (
                      <div>
                        Qty <span className="font-semibold text-[#1e293b]">{item.approvedQty}</span> · {item.priority}
                        <div className="mt-0.5 font-medium text-[#0f766e]">
                          {item.shippedQty} shipped · {item.openQty} remaining
                        </div>
                      </div>
                    ) : (
                      <div>Qty <span className="font-semibold text-[#1e293b]">{item.qty}</span> · {item.priority}</div>
                    )}
                    {item.inWarehouse ? <div className="mt-1 font-semibold text-[#1d4ed8]">Preparing for shipment</div> : null}
                    {item.warehouseQty > 0 && item.waitingQty > 0 ? <div className="mt-1 font-medium text-[#475569]">{item.warehouseQty} In Warehouse · {item.waitingQty} Waiting</div> : null}
                    <div className="mt-1 truncate text-[#64748b]">Persisted: {item.assignedTo} · {item.status}</div>
                    <div className="mt-1 truncate font-medium text-[#475569]">Forecast: {item.expectedAvailability}</div>
                  </div>
                  {item.orderId ? <Link href={`/orders/${item.orderId}`} className="inline-flex whitespace-nowrap rounded-md border border-[#bfdbfe] bg-white px-2.5 py-1.5 font-semibold text-[#1d4ed8] hover:border-[#93c5fd] hover:bg-[#eff6ff]">View Invoice</Link> : <span>—</span>}
                  {adminMode && item.lineId ? (
                    <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
                      <label className="sr-only" htmlFor={`reason-${item.lineId}`}>Reason for moving customer</label>
                      <form action={moveCustomerQueuePositionAction} className="flex flex-1 flex-wrap items-center gap-2">
                        <input type="hidden" name="line_id" value={item.lineId} />
                        <label className="sr-only" htmlFor={`reason-${item.lineId}`}>Reason for moving customer</label>
                        <input id={`reason-${item.lineId}`} name="queue_position_reason" placeholder="Reason for moving" required className="min-w-[180px] flex-1 rounded-md border border-[#cbd5e1] px-2 py-1" />
                        <button type="submit" name="direction" value="up" aria-label={`Move ${item.customer} up`} title="Move up" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#cbd5e1] bg-white text-base font-bold text-[#334155] hover:bg-[#eff6ff]">↑</button>
                        <button type="submit" name="direction" value="down" aria-label={`Move ${item.customer} down`} title="Move down" className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[#cbd5e1] bg-white text-base font-bold text-[#334155] hover:bg-[#eff6ff]">↓</button>
                      </form>
                    </div>
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
