"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { moveOrderToWarehouseAction } from "./actions";
import { getOrderLifecycleLabel, getOrderSearchResultHref, searchOrders } from "@/lib/orders/orders-search";
import { sortNewOrdersByOperationalRecency } from "@/lib/orders/order-visibility";

export type OrdersBrowserRow = {
  id: string;
  invoiceNumber: string;
  customerName: string;
  createdAt: string;
  updatedAt: string;
  searchable: string;
  hasPhysicalLines: boolean;
  itemCount: number;
  totalQty: number;
  shippedQty: number;
  remainingQty: number;
  remainingStatus: string;
  tabs: string[];
  recommendedForWarehouse: boolean;
};

type TabCounts = Record<"orders" | "new" | "warehouse" | "partial" | "archived" | "cancelled", number>;

const tabs = [
  { id: "new", label: "New Orders" },
  { id: "orders", label: "Orders" },
  { id: "warehouse", label: "In Warehouse" },
  { id: "partial", label: "Partially Shipped" },
  { id: "archived", label: "Archived" },
  { id: "cancelled", label: "Cancelled" },
] as const;

const pageSize = 100;

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function OrdersBrowser({ rows, tabCounts, initialTab, initialPage, searchText }: {
  rows: OrdersBrowserRow[];
  tabCounts: TabCounts;
  initialTab: string;
  initialPage: number;
  searchText: string;
}) {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const globalSearchResults = useMemo(() => searchOrders(rows, searchText), [rows, searchText]);
  const globalSearchIds = useMemo(() => new Set(globalSearchResults.map((order) => order.id)), [globalSearchResults]);
  const matchingOrders = useMemo(() => rows.filter((order) => order.tabs.includes(activeTab) && (!searchText || globalSearchIds.has(order.id))), [rows, activeTab, searchText, globalSearchIds]);
  const filteredOrders = useMemo(() => activeTab === "new" ? sortNewOrdersByOperationalRecency(matchingOrders) : matchingOrders, [activeTab, matchingOrders]);
  const recommendedOrders = useMemo(() => activeTab === "warehouse" ? rows.filter((order) => order.recommendedForWarehouse && (!searchText || globalSearchIds.has(order.id))) : [], [activeTab, rows, searchText, globalSearchIds]);
  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const orderSummaries = filteredOrders.slice((safePage - 1) * pageSize, safePage * pageSize);

  useEffect(() => {
    const syncFromHistory = () => {
      const query = new URLSearchParams(window.location.search);
      setActiveTab(query.get("tab") || "new");
      setCurrentPage(Math.max(1, Number.parseInt(query.get("page") || "1", 10) || 1));
    };
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, []);

  function updateUrl(tab: string, page = 1) {
    const query = new URLSearchParams();
    query.set("tab", tab);
    if (searchText) query.set("q", searchText);
    if (page > 1) query.set("page", String(page));
    window.history.pushState({}, "", `/orders?${query.toString()}`);
  }

  function selectTab(tab: string) {
    setActiveTab(tab);
    setCurrentPage(1);
    updateUrl(tab);
  }

  function selectPage(page: number) {
    const nextPage = Math.max(1, Math.min(totalPages, page));
    setCurrentPage(nextPage);
    updateUrl(activeTab, nextPage);
  }

  const renderOrderTable = (orders: OrdersBrowserRow[], showRecommendedBadge = false) => (
    <div className="overflow-x-auto rounded-xl border border-[#e5e7eb]">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead className="bg-[#f8fafc]"><tr className="border-b border-[#e5e7eb] text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]"><th className="px-3 py-3">Order / Customer</th><th className="px-3 py-3">Ordered</th><th className="px-3 py-3">Shipped</th><th className="px-3 py-3">Remaining</th><th className="px-3 py-3">Remaining Status</th><th className="px-3 py-3">Order Date</th><th className="px-3 py-3 text-right">Actions</th></tr></thead>
        <tbody>{orders.map((order) => <tr key={order.id} className="border-b border-[#f1f5f9] last:border-0 hover:bg-[#fafbfc]">
          <td className="px-3 py-3"><Link href={`/orders/${order.id}`} className="font-semibold text-[#1d4ed8] hover:underline">{order.invoiceNumber}</Link>{showRecommendedBadge ? <span className="ml-2 rounded-full bg-[#dbeafe] px-2 py-1 text-xs font-semibold text-[#1d4ed8]">Recommended</span> : null}<div className="mt-1 text-xs text-[#64748b]">{order.customerName}</div></td>
          <td className="px-3 py-3 font-semibold">{order.hasPhysicalLines ? `${order.itemCount} items · ${order.totalQty} units` : "Service / no inventory"}</td>
          <td className="px-3 py-3 font-semibold text-[#0f766e]">{order.hasPhysicalLines ? `${order.shippedQty} of ${order.totalQty}` : "—"}</td>
          <td className="px-3 py-3 font-semibold text-[#b45309]">{order.hasPhysicalLines ? order.remainingQty : "—"}</td>
          <td className="px-3 py-3 font-semibold text-[#334155]">{order.hasPhysicalLines ? order.remainingStatus : "No physical fulfillment"}</td>
          <td className="px-3 py-3 text-xs text-[#475569]">{formatDate(order.createdAt)}</td>
          <td className="px-3 py-3 text-right"><div className="flex justify-end gap-2"><Link href={`/orders/${order.id}`} className="btn-secondary inline-flex text-xs">View</Link>{(activeTab === "new" || showRecommendedBadge) && order.hasPhysicalLines ? <form action={moveOrderToWarehouseAction}><input type="hidden" name="orderId" value={order.id} /><button type="submit" className="btn-primary inline-flex text-xs">Move to Warehouse</button></form> : null}</div></td>
        </tr>)}</tbody>
      </table>
    </div>
  );

  return <>
    <div className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
      <form method="GET" className="mb-4 flex flex-wrap gap-2"><input type="hidden" name="tab" value={activeTab} /><input name="q" defaultValue={searchText} placeholder="Filter by item number, invoice, or customer" className="input min-w-[280px] flex-1" /><button type="submit" className="btn-secondary">Filter</button><Link href={`/orders?tab=${activeTab}`} className="btn-ghost">Clear</Link></form>
      <div className="flex flex-wrap gap-2">{tabs.map((tab) => { const isActive = tab.id === activeTab; return <button key={tab.id} type="button" aria-current={isActive ? "page" : undefined} className={`rounded-full px-3 py-2 text-sm font-semibold ${isActive ? "bg-[#111827] text-white" : "bg-[#f3f4f6] text-[#374151] hover:bg-[#e5e7eb]"}`} onClick={() => selectTab(tab.id)}>{tab.label} ({tabCounts[tab.id]})</button>; })}</div>
    </div>

    <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
      {activeTab === "warehouse" ? <details className="mb-4"><summary className="btn-secondary inline-flex cursor-pointer">See Recommended ({recommendedOrders.length})</summary><div className="mt-3 space-y-3"><p className="rounded-lg border border-[#bfdbfe] bg-[#eff6ff] p-3 text-sm text-[#1e3a8a]">Up to 10 complete, unshipped orders that can be packed from current on-floor inventory, selected oldest first. Orders already assigned to warehouse or floor inventory are excluded from available stock.</p>{recommendedOrders.length > 0 ? renderOrderTable(recommendedOrders, true) : <p className="text-sm text-[#64748b]">No orders are currently recommended.</p>}</div></details> : null}
      {globalSearchResults.length > 1 ? <div className="mb-4 overflow-hidden rounded-lg border border-[#dbe3ee]"><div className="border-b border-[#dbe3ee] bg-[#f8fafc] px-3 py-2 text-xs font-semibold uppercase tracking-[0.06em] text-[#475569]">Search Results Across All Statuses</div><div className="divide-y divide-[#eef2f7]">{globalSearchResults.map((order) => <Link key={order.id} href={getOrderSearchResultHref(order)} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 hover:bg-[#f8fafc]"><span className="font-semibold text-[#1d4ed8]">{order.invoiceNumber} <span className="font-normal text-[#64748b]">· {order.customerName}</span></span><span className="rounded-full bg-[#eff6ff] px-2 py-1 text-xs font-semibold text-[#1d4ed8]">{getOrderLifecycleLabel(order)}</span></Link>)}</div></div> : null}
      {orderSummaries.length === 0 ? <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]"><p>{searchText ? "No orders match that filter in this status." : "No orders match this status yet."}</p></div> : renderOrderTable(orderSummaries)}
      {filteredOrders.length > pageSize ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-[#475569]"><span>Showing {(safePage - 1) * pageSize + 1}-{Math.min(safePage * pageSize, filteredOrders.length)} of {filteredOrders.length}</span><div className="flex items-center gap-2"><button type="button" onClick={() => selectPage(safePage - 1)} disabled={safePage <= 1} className="btn-secondary disabled:pointer-events-none disabled:opacity-50">Previous</button><span className="font-semibold text-[#334155]">Page {safePage} of {totalPages}</span><button type="button" onClick={() => selectPage(safePage + 1)} disabled={safePage >= totalPages} className="btn-secondary disabled:pointer-events-none disabled:opacity-50">Next</button></div></div> : null}
    </div>
  </>;
}
