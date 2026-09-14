"use client";

import { useMemo, useState } from "react";

type CandidateOrder = {
  id: string;
  invoice: string;
  customer: string;
  city: string;
  address: string;
  ready: string;
  deadline: string;
  weight: number;
  space: number;
  requirements: string;
};

const sampleOrders: CandidateOrder[] = [
  { id: "sample-1", invoice: "126214", customer: "Metro Auto Storage", city: "Dallas, TX", address: "Shipping address verified", ready: "Sep 16", deadline: "Sep 20", weight: 3240, space: 14, requirements: "Commercial dock" },
  { id: "sample-2", invoice: "126228", customer: "Fort Worth Classics", city: "Fort Worth, TX", address: "Shipping address verified", ready: "Sep 17", deadline: "Sep 21", weight: 2180, space: 10, requirements: "Appointment required" },
  { id: "sample-3", invoice: "126241", customer: "Arlington Motorworks", city: "Arlington, TX", address: "Shipping address verified", ready: "Sep 16", deadline: "Sep 19", weight: 1675, space: 8, requirements: "Customer forklift" },
];

const secondSuggestion: CandidateOrder[] = [
  { id: "sample-4", invoice: "126255", customer: "Hill Country Garage", city: "Austin, TX", address: "Shipping address verified", ready: "Sep 18", deadline: "Sep 24", weight: 2810, space: 12, requirements: "Limited access" },
  { id: "sample-5", invoice: "126263", customer: "Central Texas Motors", city: "Waco, TX", address: "Shipping address needs review", ready: "Sep 19", deadline: "Sep 25", weight: 1940, space: 9, requirements: "Unloading method missing" },
];

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function SuggestionCard({ title, distance, orders, defaultOpen = false }: { title: string; distance: string; orders: CandidateOrder[]; defaultOpen?: boolean }) {
  const [includedIds, setIncludedIds] = useState(() => new Set(orders.map((order) => order.id)));
  const [separateQuote, setSeparateQuote] = useState("");
  const [combinedQuote, setCombinedQuote] = useState("");
  const [decision, setDecision] = useState<"review" | "approved" | "dismissed">("review");
  const included = orders.filter((order) => includedIds.has(order.id));
  const totals = useMemo(() => included.reduce((result, order) => ({ weight: result.weight + order.weight, space: result.space + order.space }), { weight: 0, space: 0 }), [included]);
  const separate = Number(separateQuote);
  const combined = Number(combinedQuote);
  const comparable = separate > 0 && combined > 0;
  const savings = comparable ? separate - combined : null;

  function toggleOrder(id: string) {
    setIncludedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setDecision("review");
  }

  return (
    <details open={defaultOpen} className="overflow-hidden rounded-2xl border border-[#dbe3ee] bg-white shadow-sm">
      <summary className="cursor-pointer list-none px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold text-[#111827]">{title}</h2><span className="rounded-full bg-[#fef3c7] px-2.5 py-1 text-xs font-semibold text-[#92400e]">Quote required</span>{decision !== "review" ? <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${decision === "approved" ? "bg-[#dcfce7] text-[#166534]" : "bg-[#f1f5f9] text-[#475569]"}`}>{decision === "approved" ? "Mock approved" : "Dismissed"}</span> : null}</div><p className="mt-1 text-sm text-[#64748b]">Olympic main warehouse · {included.length} stops · {distance}</p></div>
          <span className="text-sm font-semibold text-[#1d4ed8]">Review suggestion</span>
        </div>
      </summary>

      <div className="border-t border-[#e5e7eb] p-5">
        <div className="grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
          <div className="space-y-4">
            <div className="rounded-xl border border-[#dbeafe] bg-[#f8fbff] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#64748b]">Proposed route</p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[#111827] px-3 py-2 text-xs font-semibold text-white">Warehouse</span>
                {included.map((order, index) => <div key={order.id} className="flex items-center gap-2"><span className="text-[#94a3b8]">→</span><span className="rounded-full border border-[#93c5fd] bg-white px-3 py-2 text-xs font-semibold text-[#1e3a8a]">{index + 1}. {order.city}</span></div>)}
              </div>
            </div>

            <div className="space-y-3">
              {orders.map((order) => {
                const isIncluded = includedIds.has(order.id);
                const addressWarning = order.address.includes("review");
                return <label key={order.id} className={`block cursor-pointer rounded-xl border p-4 transition ${isIncluded ? "border-[#93c5fd] bg-[#f8fbff]" : "border-[#e5e7eb] bg-[#fafafa] opacity-70"}`}>
                  <div className="flex items-start gap-3"><input type="checkbox" checked={isIncluded} onChange={() => toggleOrder(order.id)} className="mt-1 h-4 w-4 accent-[#d50917]"/><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-[#111827]">Invoice #{order.invoice} · {order.customer}</p><span className="text-xs font-semibold text-[#475569]">{order.city}</span></div><p className={`mt-1 text-xs ${addressWarning ? "font-semibold text-[#b45309]" : "text-[#15803d]"}`}>{addressWarning ? "⚠ " : "✓ "}{order.address}</p><div className="mt-3 grid gap-2 text-sm text-[#475569] sm:grid-cols-2 lg:grid-cols-4"><span><b>Ready:</b> {order.ready}</span><span><b>Deliver by:</b> {order.deadline}</span><span><b>Weight:</b> {order.weight.toLocaleString()} lb</span><span><b>Deck:</b> {order.space} ft</span></div><p className="mt-2 text-xs text-[#64748b]">{order.requirements}</p></div></div>
                </label>;
              })}
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-xl border border-[#e5e7eb] p-4"><p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#64748b]">Load check</p><dl className="mt-3 space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-[#64748b]">Combined weight</dt><dd className="font-semibold">{totals.weight.toLocaleString()} lb</dd></div><div className="flex justify-between gap-3"><dt className="text-[#64748b]">Estimated deck</dt><dd className="font-semibold">{totals.space} ft</dd></div><div className="flex justify-between gap-3"><dt className="text-[#64748b]">Ready window</dt><dd className="font-semibold">3 days</dd></div></dl><div className="mt-4 rounded-lg border border-[#fde68a] bg-[#fffbeb] p-3 text-xs text-[#854d0e]">Trailer fit and stackability require staff confirmation.</div></div>

            <div className="rounded-xl border border-[#e5e7eb] p-4"><p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#64748b]">Quote comparison</p><label className="mt-3 block text-sm font-medium text-[#334155]">Separate shipments<input type="number" min="0" value={separateQuote} onChange={(event) => setSeparateQuote(event.target.value)} placeholder="$0" className="input mt-1 w-full" /></label><label className="mt-3 block text-sm font-medium text-[#334155]">Combined multi-stop quote<input type="number" min="0" value={combinedQuote} onChange={(event) => setCombinedQuote(event.target.value)} placeholder="$0" className="input mt-1 w-full" /></label><div className={`mt-4 rounded-lg p-3 ${savings !== null && savings > 0 ? "bg-[#ecfdf5] text-[#166534]" : "bg-[#f8fafc] text-[#475569]"}`}><p className="text-xs font-semibold uppercase tracking-[0.08em]">Estimated savings</p><p className="mt-1 text-xl font-bold">{savings === null ? "Quote required" : money(savings)}</p>{savings !== null && savings <= 0 ? <p className="mt-1 text-xs">Separate shipping is currently less expensive.</p> : null}</div></div>

            <div className="flex flex-wrap gap-2"><button type="button" disabled={included.length < 2 || !comparable} onClick={() => setDecision("approved")} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">Approve mock group</button><button type="button" onClick={() => setDecision("dismissed")} className="btn-secondary">Dismiss</button></div>
          </aside>
        </div>
      </div>
    </details>
  );
}

export function FreightConsolidationMock() {
  const [radius, setRadius] = useState("75");
  const [windowDays, setWindowDays] = useState("3");

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm"><div className="flex flex-wrap items-end gap-4"><label className="text-sm font-medium text-[#334155]">Maximum destination radius<input value={radius} onChange={(event) => setRadius(event.target.value)} className="input mt-1 w-36" inputMode="numeric" /><span className="ml-2 text-sm text-[#64748b]">miles</span></label><label className="text-sm font-medium text-[#334155]">Ready-date window<input value={windowDays} onChange={(event) => setWindowDays(event.target.value)} className="input mt-1 w-28" inputMode="numeric" /><span className="ml-2 text-sm text-[#64748b]">days</span></label><button type="button" className="btn-primary">Refresh mock suggestions</button><p className="basis-full text-xs text-[#64748b]">Current mock rule: same warehouse, within approximately {radius || "—"} miles, and ready within {windowDays || "—"} days.</p></div></section>
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold text-[#111827]">2 potential groups</h2><p className="mt-1 text-sm text-[#64748b]">Ranked for human review; no freight has been booked.</p></div><span className="rounded-full bg-[#eef2ff] px-3 py-1 text-sm font-semibold text-[#3730a3]">5 candidate orders</span></div>
      <SuggestionCard title="DFW metro route" distance="42-mile destination spread" orders={sampleOrders} defaultOpen />
      <SuggestionCard title="I-35 south route" distance="Waco stop along Austin route" orders={secondSuggestion} />
    </div>
  );
}
