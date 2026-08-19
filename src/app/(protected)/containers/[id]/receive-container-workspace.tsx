"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { receiveContainerAction } from "@/app/(protected)/containers/actions";
import { coverProduct, type DemandByProduct } from "@/lib/containers/coverage-math";

type LineInput = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  expectedQty: number;
  assignedQty: number;
  demandQty: number;
  isUnplanned: boolean;
};

type ExtraItem = { key: string; productId: string; quantity: string; note: string };

type ProductOption = { id: string; sku: string | null; name: string | null };

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Recording receipt…" : "Confirm Receipt"}
    </button>
  );
}

function differenceLabel(expected: number, actual: number) {
  const difference = actual - expected;
  if (difference === 0) return { text: "Match", tone: "bg-[#f3f4f6] text-[#4b5563]" };
  if (difference < 0) {
    const isMissing = actual === 0 && expected > 0;
    return {
      text: `${difference} ${isMissing ? "MISSING" : "SHORT"}`,
      tone: "bg-[#fee2e2] text-[#b91c1c]",
    };
  }
  return { text: `+${difference} EXTRA`, tone: "bg-[#fff7e6] text-[#b45309]" };
}

function ProductSearch({
  options,
  value,
  onSelect,
}: {
  options: ProductOption[];
  value: string;
  onSelect: (productId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = options.find((option) => option.id === value) ?? null;

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    return options
      .filter((option) => `${option.sku ?? ""} ${option.name ?? ""}`.toLowerCase().includes(term))
      .slice(0, 8);
  }, [options, query]);

  if (selected) {
    return (
      <div className="mt-1 flex items-center gap-2 rounded-lg border border-[#d1d5db] px-2 py-1">
        <span className="min-w-0 flex-1 truncate text-sm font-normal text-[#111827]">
          {selected.sku ?? "SKU pending"} — {selected.name ?? ""}
        </span>
        <button
          type="button"
          className="shrink-0 text-xs font-semibold text-[#2563eb] hover:underline"
          onClick={() => {
            onSelect("");
            setQuery("");
          }}
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative mt-1">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search SKU or product…"
        className="w-full rounded-lg border border-[#d1d5db] px-2 py-1 text-sm font-normal"
        aria-label="Search for a product to add"
      />
      {matches.length > 0 ? (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-[#d1d5db] bg-white shadow-lg">
          {matches.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                className="block w-full px-2 py-1.5 text-left text-sm font-normal hover:bg-[#f1f5f9]"
                onClick={() => {
                  onSelect(option.id);
                  setQuery("");
                }}
              >
                <span className="font-medium text-[#111827]">{option.sku ?? "SKU pending"}</span>{" "}
                <span className="text-[#64748b]">{option.name ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() ? (
        <p className="mt-1 text-xs font-normal text-[#64748b]">No matching products.</p>
      ) : null}
    </div>
  );
}

export function ReceiveContainerWorkspace({
  containerId,
  containerNumber,
  lines,
  demandByProduct,
  productOptions,
}: {
  containerId: string;
  containerNumber: string;
  lines: LineInput[];
  demandByProduct: DemandByProduct;
  productOptions: ProductOption[];
}) {
  const [receivedByLine, setReceivedByLine] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.id, ""])),
  );
  const [extras, setExtras] = useState<ExtraItem[]>([]);
  const [reviewing, setReviewing] = useState(false);

  const productById = useMemo(() => new Map(productOptions.map((product) => [product.id, product])), [productOptions]);

  const extraQtyByProduct = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const extra of extras) {
      if (!extra.productId) continue;
      totals[extra.productId] = (totals[extra.productId] ?? 0) + Math.max(0, Number(extra.quantity) || 0);
    }
    return totals;
  }, [extras]);

  const actualByProduct = useMemo(() => {
    const totals: Record<string, number> = { ...extraQtyByProduct };
    for (const line of lines) {
      const actual = Math.max(0, Number(receivedByLine[line.id]) || 0);
      totals[line.productId] = (totals[line.productId] ?? 0) + actual;
    }
    return totals;
  }, [lines, receivedByLine, extraQtyByProduct]);

  const expectedTotal = lines.reduce((sum, line) => sum + line.expectedQty, 0);
  const actualTotal =
    lines.reduce((sum, line) => sum + (Math.max(0, Number(receivedByLine[line.id]) || 0)), 0) +
    Object.values(extraQtyByProduct).reduce((sum, qty) => sum + qty, 0);
  const shortTotal = lines.reduce(
    (sum, line) => sum + Math.max(0, line.expectedQty - (Math.max(0, Number(receivedByLine[line.id]) || 0))),
    0,
  );
  const extraTotal =
    lines.reduce((sum, line) => sum + Math.max(0, (Math.max(0, Number(receivedByLine[line.id]) || 0)) - line.expectedQty), 0) +
    Object.values(extraQtyByProduct).reduce((sum, qty) => sum + qty, 0);

  const varianceRows = useMemo(() => {
    const rows = lines.map((line) => {
      const actual = Math.max(0, Number(receivedByLine[line.id]) || 0);
      const demand = demandByProduct[line.productId] ?? [];
      const coveredExpected = coverProduct(demand, line.expectedQty).coveredCustomerCount;
      const actualForProduct = actualByProduct[line.productId] ?? 0;
      const actualCoverage = coverProduct(demand, actualForProduct);
      const lostCustomers = Math.max(0, coveredExpected - actualCoverage.coveredCustomerCount);

      let impact = "No change";
      if (lostCustomers > 0) {
        impact = `${lostCustomers} customer${lostCustomers === 1 ? "" : "s"} returned to waiting`;
      } else if (actualCoverage.extraUnits > 0) {
        impact = `${actualCoverage.extraUnits} extra available`;
      }

      return { key: line.id, sku: line.sku, expected: line.expectedQty, actual, impact, isUnplanned: line.isUnplanned };
    });

    for (const extra of extras) {
      if (!extra.productId) continue;
      const quantity = Math.max(0, Number(extra.quantity) || 0);
      if (quantity <= 0) continue;
      const product = productById.get(extra.productId);
      const demand = demandByProduct[extra.productId] ?? [];
      const coverage = coverProduct(demand, actualByProduct[extra.productId] ?? 0);
      rows.push({
        key: extra.key,
        sku: product?.sku ?? product?.name ?? "New item",
        expected: 0,
        actual: quantity,
        impact: coverage.extraUnits > 0 ? `${coverage.extraUnits} extra available` : "Covers waiting demand",
        isUnplanned: true,
      });
    }

    return rows;
  }, [lines, receivedByLine, extras, demandByProduct, actualByProduct, productById]);

  const payload = JSON.stringify({
    entries: [
      ...lines.map((line) => ({
        containerLineId: line.id,
        productId: line.productId,
        receivedQty: Math.max(0, Number(receivedByLine[line.id]) || 0),
        note: "",
      })),
      ...extras
        .filter((extra) => extra.productId && Math.max(0, Number(extra.quantity) || 0) > 0)
        .map((extra) => ({
          containerLineId: null,
          productId: extra.productId,
          receivedQty: Math.max(0, Number(extra.quantity) || 0),
          note: extra.note.trim(),
        })),
    ],
  });

  const untouched = lines.every((line) => receivedByLine[line.id] === "") && extras.length === 0;

  return (
    <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-[#111827]">Record Received Quantities</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">
            Enter what physically arrived. Planned quantities are a forecast and never create inventory on their own.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() =>
            setReceivedByLine(Object.fromEntries(lines.map((line) => [line.id, String(line.expectedQty)])))
          }
        >
          Fill with expected
        </button>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-[900px] w-full divide-y divide-[#e5e7eb] text-sm">
          <thead className="bg-[#f9fafb] text-left text-[#6b7280]">
            <tr>
              <th className="px-3 py-3 font-semibold">SKU</th>
              <th className="px-3 py-3 font-semibold">Product</th>
              <th className="px-3 py-3 font-semibold">Expected</th>
              <th className="px-3 py-3 font-semibold">Assigned to Customers</th>
              <th className="px-3 py-3 font-semibold">Actual Received</th>
              <th className="px-3 py-3 font-semibold">Difference</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#e5e7eb] bg-white">
            {lines.map((line) => {
              const raw = receivedByLine[line.id];
              const actual = Math.max(0, Number(raw) || 0);
              const badge = differenceLabel(line.expectedQty, actual);
              return (
                <tr key={line.id}>
                  <td className="px-3 py-3 font-medium text-[#111827]">
                    {line.sku}
                    {line.isUnplanned ? (
                      <span className="ml-2 rounded-full bg-[#fff7e6] px-2 py-0.5 text-[11px] font-semibold text-[#b45309]">
                        Unplanned
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-[#4b5563]">{line.productName}</td>
                  <td className="px-3 py-3">{line.expectedQty}</td>
                  <td className="px-3 py-3">{line.assignedQty}</td>
                  <td className="px-3 py-3">
                    <input
                      type="number"
                      min="0"
                      value={raw}
                      placeholder="0"
                      onChange={(event) =>
                        setReceivedByLine((current) => ({ ...current, [line.id]: event.target.value }))
                      }
                      className="w-24 rounded-lg border border-[#d1d5db] px-2 py-1 text-sm"
                      aria-label={`Actual received quantity for ${line.sku}`}
                    />
                  </td>
                  <td className="px-3 py-3">
                    {raw === "" ? (
                      <span className="text-xs text-[#9ca3af]">Not counted</span>
                    ) : (
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${badge.tone}`}>{badge.text}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-5 rounded-xl border border-[#e5e7eb] bg-[#fbfdff] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[#111827]">Unplanned / Extra Items</h3>
            <p className="mt-1 text-xs text-[#64748b]">Items that arrived but were not on the container manifest.</p>
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              setExtras((current) => [
                ...current,
                { key: `extra-${Date.now()}-${current.length}`, productId: "", quantity: "", note: "" },
              ])
            }
          >
            + Add Received Item
          </button>
        </div>

        {extras.length > 0 ? (
          <div className="mt-3 grid gap-3">
            {extras.map((extra) => (
              <div key={extra.key} className="grid gap-2 rounded-lg border border-[#e5e7eb] bg-white p-3 md:grid-cols-[2fr_1fr_2fr_auto]">
                <div className="text-xs font-semibold text-[#64748b]">
                  Product / SKU
                  <ProductSearch
                    options={productOptions}
                    value={extra.productId}
                    onSelect={(productId) =>
                      setExtras((current) =>
                        current.map((item) => (item.key === extra.key ? { ...item, productId } : item)),
                      )
                    }
                  />
                </div>
                <label className="text-xs font-semibold text-[#64748b]">
                  Actual received
                  <input
                    type="number"
                    min="0"
                    value={extra.quantity}
                    onChange={(event) =>
                      setExtras((current) =>
                        current.map((item) => (item.key === extra.key ? { ...item, quantity: event.target.value } : item)),
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-[#d1d5db] px-2 py-1 text-sm"
                  />
                </label>
                <label className="text-xs font-semibold text-[#64748b]">
                  Note (optional)
                  <input
                    value={extra.note}
                    onChange={(event) =>
                      setExtras((current) =>
                        current.map((item) => (item.key === extra.key ? { ...item, note: event.target.value } : item)),
                      )
                    }
                    className="mt-1 w-full rounded-lg border border-[#d1d5db] px-2 py-1 text-sm"
                  />
                </label>
                <button
                  type="button"
                  className="btn-secondary self-end"
                  onClick={() => setExtras((current) => current.filter((item) => item.key !== extra.key))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {!reviewing ? (
        <div className="mt-5 flex justify-end">
          <button type="button" className="btn-primary" disabled={untouched} onClick={() => setReviewing(true)}>
            Review Receipt
          </button>
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-[#bfdbfe] bg-[#f8fbff] p-4">
          <h3 className="text-lg font-semibold text-[#111827]">Container {containerNumber} — Receipt Reconciliation</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <div><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Expected units</p><p className="text-2xl font-bold text-[#111827]">{expectedTotal}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Actual received</p><p className="text-2xl font-bold text-[#111827]">{actualTotal}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Short</p><p className="text-2xl font-bold text-[#b91c1c]">{shortTotal}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Extra</p><p className="text-2xl font-bold text-[#b45309]">{extraTotal}</p></div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[760px] w-full divide-y divide-[#e5e7eb] text-sm">
              <thead className="bg-white text-left text-[#6b7280]">
                <tr>
                  <th className="px-3 py-2 font-semibold">SKU</th>
                  <th className="px-3 py-2 font-semibold">Expected</th>
                  <th className="px-3 py-2 font-semibold">Actual</th>
                  <th className="px-3 py-2 font-semibold">Difference</th>
                  <th className="px-3 py-2 font-semibold">Customer Impact</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e5e7eb] bg-white">
                {varianceRows.map((row) => {
                  const badge = differenceLabel(row.expected, row.actual);
                  return (
                    <tr key={row.key}>
                      <td className="px-3 py-2 font-medium text-[#111827]">
                        {row.sku}
                        {row.isUnplanned ? (
                          <span className="ml-2 rounded-full bg-[#fff7e6] px-2 py-0.5 text-[11px] font-semibold text-[#b45309]">
                            Unplanned
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">{row.expected}</td>
                      <td className="px-3 py-2">{row.actual}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${badge.tone}`}>{badge.text}</span>
                      </td>
                      <td className="px-3 py-2 text-[#4b5563]">{row.impact}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-[#64748b]">
            Confirming writes received quantities and adds {actualTotal} unit(s) to On Floor. Orders are not moved to In Warehouse —
            that stays a manual step for your warehouse team.
          </p>

          <form action={receiveContainerAction} className="mt-4 flex flex-wrap justify-end gap-2">
            <input type="hidden" name="container_id" value={containerId} />
            <input type="hidden" name="container_number" value={containerNumber} />
            <input type="hidden" name="receipt_payload" value={payload} />
            <button type="button" className="btn-secondary" onClick={() => setReviewing(false)}>
              Back to counts
            </button>
            <ConfirmButton />
          </form>
        </div>
      )}
    </div>
  );
}
