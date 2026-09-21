"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { updateContainerManifestAction } from "@/app/(protected)/containers/actions";

type ManifestLine = { id: string; productId: string; sku: string; productName: string; plannedQty: number };
type ProductOption = { id: string; sku: string | null; name: string | null };

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-secondary" disabled={pending}>
      {pending ? "Saving manifest…" : "Save Planned Manifest"}
    </button>
  );
}

export function EditContainerManifestWorkspace({
  containerId,
  lines,
  productOptions,
  notes,
}: {
  containerId: string;
  lines: ManifestLine[];
  productOptions: ProductOption[];
  notes: string;
}) {
  const [draftLines, setDraftLines] = useState(() => lines.map((line) => ({ ...line, plannedQty: String(line.plannedQty) })));
  const [addProductId, setAddProductId] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [draftNotes, setDraftNotes] = useState(notes);
  const availableProducts = useMemo(() => {
    const selected = new Set(draftLines.map((line) => line.productId));
    return productOptions.filter((product) => !selected.has(product.id));
  }, [draftLines, productOptions]);

  function addProduct() {
    const product = availableProducts.find((candidate) => candidate.id === addProductId);
    const quantity = Math.floor(Number(addQty));
    if (!product || !Number.isFinite(quantity) || quantity <= 0) return;
    setDraftLines((current) => [...current, { id: product.id, productId: product.id, sku: product.sku ?? "SKU pending", productName: product.name ?? "Product", plannedQty: String(quantity) }]);
    setAddProductId("");
    setAddQty("1");
  }

  const manifestPayload = useMemo(() => {
    const originalIds = new Set(lines.map((line) => line.id));
    return JSON.stringify({
      lines: draftLines.filter((line) => originalIds.has(line.id)).map((line) => ({ id: line.id, plannedQty: Number(line.plannedQty) || 0 })),
      additions: draftLines.filter((line) => !originalIds.has(line.id)).map((line) => ({ productId: line.productId, plannedQty: Number(line.plannedQty) || 0 })),
      notes: draftNotes,
    });
  }, [draftLines, draftNotes, lines]);

  return (
    <section className="rounded-2xl border border-[#bfdbfe] bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-[#111827]">Edit Planned Manifest</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">Correct expected items or quantities when an order changes before this container is received.</p>
        </div>
        <span className="rounded-full bg-[#eff6ff] px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#1d4ed8]">Planned only</span>
      </div>

      <div className="mt-4 rounded-lg border border-[#bfdbfe] bg-[#f0f7ff] p-3 text-sm text-[#1e3a8a]">
        Saving this form does <strong>not</strong> receive the container, create inventory, or change On Floor quantities. Actual receipt remains a separate step below.
      </div>

      <form action={updateContainerManifestAction} className="mt-5 space-y-4">
        <input type="hidden" name="container_id" value={containerId} />
        <input type="hidden" name="manifest_payload" value={manifestPayload} />

        <div className="space-y-2">
          {draftLines.length === 0 ? <p className="rounded-lg border border-dashed border-[#d1d5db] p-3 text-sm text-[#6b7280]">No planned items. Add one below.</p> : null}
          {draftLines.map((line) => (
            <div key={line.id} className="grid gap-3 rounded-lg border border-[#e5e7eb] p-3 sm:grid-cols-[1fr_120px_auto] sm:items-center">
              <div className="min-w-0"><p className="font-semibold text-[#111827]">{line.sku}</p><p className="truncate text-sm text-[#5a5a5a]">{line.productName}</p></div>
              <label className="text-sm font-medium text-[#374151]">Planned qty<input aria-label={`Planned quantity for ${line.sku}`} type="number" min="0" step="1" value={line.plannedQty} onChange={(event) => setDraftLines((current) => current.map((item) => item.id === line.id ? { ...item, plannedQty: event.target.value } : item))} className="mt-1 w-full rounded-md border border-[#d1d5db] px-2 py-1.5" /></label>
              <button type="button" onClick={() => setDraftLines((current) => current.filter((item) => item.id !== line.id))} className="text-sm font-semibold text-[#b91c1c] hover:underline">Remove</button>
            </div>
          ))}
        </div>

        <div className="grid gap-3 rounded-lg bg-[#f9fafb] p-3 sm:grid-cols-[1fr_120px_auto] sm:items-end">
          <label className="text-sm font-medium text-[#374151]">Add planned product<select value={addProductId} onChange={(event) => setAddProductId(event.target.value)} className="mt-1 w-full rounded-md border border-[#d1d5db] bg-white px-2 py-2"><option value="">Select a product</option>{availableProducts.map((product) => <option key={product.id} value={product.id}>{product.sku ?? "SKU pending"} — {product.name ?? "Product"}</option>)}</select></label>
          <label className="text-sm font-medium text-[#374151]">Quantity<input type="number" min="1" step="1" value={addQty} onChange={(event) => setAddQty(event.target.value)} className="mt-1 w-full rounded-md border border-[#d1d5db] px-2 py-2" /></label>
          <button type="button" onClick={addProduct} className="btn-secondary">Add Item</button>
        </div>

        <label className="block text-sm font-medium text-[#374151]">Container notes<textarea value={draftNotes} onChange={(event) => setDraftNotes(event.target.value)} rows={3} className="mt-1 w-full rounded-md border border-[#d1d5db] px-3 py-2" /></label>
        <div className="flex justify-end"><SaveButton /></div>
      </form>
    </section>
  );
}
