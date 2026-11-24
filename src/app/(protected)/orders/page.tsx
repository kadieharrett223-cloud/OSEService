import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getExactInvoiceSearchTab } from "@/lib/orders/orders-search";
import { getCachedOrdersDataset, type ProjectedOrderRow } from "@/lib/orders/orders-list-read-model";
import { OrdersBrowser } from "./orders-browser";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; page?: string; message?: string; error?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const activeTab = params.tab ?? "new";
  const searchText = String(params.q ?? "").trim().toLowerCase();
  const currentPage = Math.max(1, Number.parseInt(String(params.page ?? "1"), 10) || 1);

  let projectedOrders: ProjectedOrderRow[] = [];
  let tabCounts = { orders: 0, new: 0, warehouse: 0, partial: 0, archived: 0, cancelled: 0 };
  let ordersLoadError: Error | null = null;
  try {
    const dataset = await getCachedOrdersDataset();
    projectedOrders = dataset.projectedOrders;
    tabCounts = dataset.tabCounts;
  } catch (error) {
    ordersLoadError = error instanceof Error ? error : new Error("Unable to load Orders data");
  }

  const exactSearchTab = getExactInvoiceSearchTab(projectedOrders, searchText);
  if (exactSearchTab && exactSearchTab !== activeTab) {
    redirect(`/orders?${new URLSearchParams({ tab: exactSearchTab, q: searchText }).toString()}`);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Orders & Shipping</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Orders</h1>
            <p className="mt-2 max-w-2xl text-sm text-[#5a5a5a]">
              Shipping operations for review, assignment, warehouse execution, shipment, and final fulfillment.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/orders/import-assign" className="btn-primary inline-flex">
              Import/Assign Review
            </Link>
            <Link href="/orders/new" className="btn-primary inline-flex">Enter QuickBooks Order</Link>
          </div>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Total Orders", tabCounts.orders, "bg-[#eff6ff] text-[#2563eb]"],
          ["New Orders", tabCounts.new, "bg-[#ecfdf5] text-[#15803d]"],
          ["In Warehouse", tabCounts.warehouse, "bg-[#fff7ed] text-[#c2410c]"],
          ["Partially Shipped", tabCounts.partial, "bg-[#fff7ed] text-[#c2410c]"],
          ["Archived", tabCounts.archived, "bg-[#eff6ff] text-[#1d4ed8]"],
        ].map(([label, value, color]) => (
          <div key={String(label)} className="rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
            <div className={`inline-flex rounded-lg px-2 py-1 text-xs font-bold ${color}`}>{label}</div>
            <p className="mt-2 text-2xl font-bold text-[#111827]">{value}</p>
          </div>
        ))}
      </section>

      {params.message ? <div className="rounded-lg border border-[#b7e4c7] bg-[#ecfdf3] p-3 text-sm text-[#166534]">{params.message}</div> : null}
      {params.error ? <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{params.error}</div> : null}
      {ordersLoadError ? <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Unable to load orders right now.</div> : null}
      <OrdersBrowser key={`${activeTab}:${searchText}`} rows={projectedOrders} tabCounts={tabCounts} initialTab={activeTab} initialPage={currentPage} searchText={searchText} />
    </div>
  );
}
