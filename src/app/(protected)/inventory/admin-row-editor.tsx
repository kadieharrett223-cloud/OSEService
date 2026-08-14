"use client";

import { useEffect, useRef, useState } from "react";
import { adjustProductStockAction, updateProductTitleAction } from "@/app/(protected)/inventory/actions";

type AdminRowEditorProps = {
  productId: string;
  sku: string;
  productName: string;
  storedName: string;
  onFloor: number;
};

export function AdminRowEditor({ productId, sku, productName, storedName, onFloor }: AdminRowEditorProps) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    function onPointerDown(event: MouseEvent) {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 text-xs font-medium text-[#b45309] underline decoration-dotted underline-offset-2 transition hover:text-[#92400e]"
      >
        Edit
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div ref={dialogRef} role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-[#111827]">Edit product</h2>
            <p className="mt-1 text-sm text-[#6b7280]">
              {productName} · SKU {sku}
            </p>

            <form action={updateProductTitleAction} className="mt-4 space-y-2">
              <input type="hidden" name="product_id" value={productId} />
              <label className="label" htmlFor={`title-${productId}`}>Product title</label>
              <input id={`title-${productId}`} name="canonical_name" className="input" defaultValue={storedName} />
              <button type="submit" className="rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#1f2937]">
                Save title
              </button>
            </form>

            <form action={adjustProductStockAction} className="mt-6 space-y-2 border-t border-[#e5e7eb] pt-5">
              <input type="hidden" name="product_id" value={productId} />
              <label className="label" htmlFor={`stock-${productId}`}>On floor quantity</label>
              <input
                id={`stock-${productId}`}
                name="on_floor_qty"
                type="number"
                step="1"
                min="0"
                className="input"
                defaultValue={onFloor}
              />
              <label className="label" htmlFor={`stock-reason-${productId}`}>Reason</label>
              <input
                id={`stock-reason-${productId}`}
                name="reason"
                className="input"
                placeholder="Cycle count, damage, correction..."
                required
              />
              <p className="text-xs text-[#6b7280]">Recorded as an adjustment against the current count of {onFloor}.</p>
              <button type="submit" className="rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#1f2937]">
                Save stock
              </button>
            </form>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-[#d1d5db] px-4 py-2 text-sm font-semibold text-[#374151] transition hover:bg-[#f9fafb]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
