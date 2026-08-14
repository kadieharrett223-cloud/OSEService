"use client";

import { useEffect, useRef, useState } from "react";
import { updateProductDisplayOrderAction } from "@/app/(protected)/inventory/actions";

type DisplayOrderButtonProps = {
  productIds: string[];
  productName: string;
  sku: string;
  group: string;
  sortOrder: number | null;
  groups: string[];
};

export function DisplayOrderButton({ productIds, productName, sku, group, sortOrder, groups }: DisplayOrderButtonProps) {
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
        className="mt-1 text-xs font-medium text-[#64748b] underline decoration-dotted underline-offset-2 transition hover:text-[#111827]"
      >
        Reorder
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div ref={dialogRef} role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-[#111827]">Display order</h2>
            <p className="mt-1 text-sm text-[#6b7280]">
              {productName} · SKU {sku}
            </p>
            <p className="mt-1 text-xs text-[#94a3b8]">Presentation only. Quantities and customer lists are unaffected.</p>

            <form action={updateProductDisplayOrderAction} className="mt-4 space-y-4">
              <input type="hidden" name="product_ids" value={productIds.join(",")} />

              <div>
                <label className="label" htmlFor={`group-${sku}`}>Group</label>
                <select id={`group-${sku}`} name="inventory_group" className="input" defaultValue={group}>
                  {groups.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label" htmlFor={`order-${sku}`}>Position in group</label>
                <input
                  id={`order-${sku}`}
                  name="inventory_sort_order"
                  type="number"
                  step="1"
                  className="input"
                  defaultValue={sortOrder ?? ""}
                  placeholder="Leave blank to sort last"
                />
                <p className="mt-1 text-xs text-[#6b7280]">Lower numbers appear first.</p>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-lg border border-[#d1d5db] px-4 py-2 text-sm font-semibold text-[#374151] transition hover:bg-[#f9fafb]"
                >
                  Cancel
                </button>
                <button type="submit" className="rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#1f2937]">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
