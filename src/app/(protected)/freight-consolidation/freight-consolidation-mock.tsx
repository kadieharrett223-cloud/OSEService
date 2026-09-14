"use client";

import { useState } from "react";

type NearbyOrder = {
  id: string;
  invoice: string;
  customer: string;
  city: string;
  status: "In Warehouse" | "Recommended for Warehouse";
  distance: string;
};

const clusters: Array<{ name: string; summary: string; orders: NearbyOrder[] }> = [
  {
    name: "Dallas–Fort Worth area",
    summary: "3 orders within approximately 34 miles",
    orders: [
      { id: "sample-1", invoice: "126214", customer: "Metro Auto Storage", city: "Dallas, TX", status: "In Warehouse", distance: "Dallas" },
      { id: "sample-2", invoice: "126228", customer: "Fort Worth Classics", city: "Fort Worth, TX", status: "Recommended for Warehouse", distance: "31 mi from Dallas" },
      { id: "sample-3", invoice: "126241", customer: "Arlington Motorworks", city: "Arlington, TX", status: "In Warehouse", distance: "20 mi from Dallas" },
    ],
  },
  {
    name: "Austin area",
    summary: "2 orders within approximately 32 miles",
    orders: [
      { id: "sample-4", invoice: "126255", customer: "Hill Country Garage", city: "Austin, TX", status: "In Warehouse", distance: "Austin" },
      { id: "sample-5", invoice: "126263", customer: "Central Texas Motors", city: "San Marcos, TX", status: "Recommended for Warehouse", distance: "32 mi from Austin" },
    ],
  },
];

function statusStyle(status: NearbyOrder["status"]) {
  return status === "In Warehouse" ? "bg-[#dcfce7] text-[#166534]" : "bg-[#dbeafe] text-[#1d4ed8]";
}

export function FreightConsolidationMock() {
  const [radius, setRadius] = useState("75");

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium text-[#334155]">Nearby distance<span className="mt-1 flex items-center gap-2"><input value={radius} onChange={(event) => setRadius(event.target.value)} className="input w-28" inputMode="numeric" /><span className="text-[#64748b]">miles</span></span></label>
          <button type="button" className="btn-primary">Refresh mock results</button>
        </div>
        <p className="mt-3 text-xs text-[#64748b]">Only orders already in the warehouse or recommended for the warehouse are compared.</p>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold text-[#111827]">Nearby order groups</h2><p className="mt-1 text-sm text-[#64748b]">Orders near the same destination are shown together.</p></div><span className="rounded-full bg-[#eef2ff] px-3 py-1 text-sm font-semibold text-[#3730a3]">2 groups · 5 orders</span></div>

      {clusters.map((cluster) => (
        <section key={cluster.name} className="overflow-hidden rounded-2xl border border-[#dbe3ee] bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#e5e7eb] px-5 py-4"><div><h3 className="text-xl font-semibold text-[#111827]">{cluster.name}</h3><p className="mt-1 text-sm text-[#64748b]">{cluster.summary}</p></div><span className="rounded-full bg-[#f1f5f9] px-3 py-1 text-sm font-semibold text-[#475569]">{cluster.orders.length} nearby</span></div>
          <div className="divide-y divide-[#eef2f7]">
            {cluster.orders.map((order) => (
              <div key={order.id} className="flex flex-wrap items-center justify-between gap-4 px-5 py-4"><div><p className="font-semibold text-[#111827]">Invoice #{order.invoice} · {order.customer}</p><p className="mt-1 text-sm text-[#475569]">{order.city}</p></div><div className="flex flex-wrap items-center gap-2"><span className="text-sm text-[#64748b]">{order.distance}</span><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyle(order.status)}`}>{order.status}</span></div></div>
            ))}
          </div>
        </section>
      ))}

      <div className="rounded-xl border border-dashed border-[#cbd5e1] bg-[#f8fafc] p-4 text-sm text-[#64748b]">Live version: OCC will use each order&apos;s QuickBooks shipping address, flag missing addresses, and group only active warehouse candidates within the selected distance.</div>
    </div>
  );
}
