import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type ContainerLineSummary = {
  product_id: string | null;
  ordered_qty: number | null;
  received_qty: number | null;
  on_order_qty: number | null;
  products?: {
    sku: string | null;
    canonical_name: string | null;
  } | null;
};

type QueueLineSummary = {
  approved_qty: number | null;
  fulfilled_qty: number | null;
};

type OrderSummary = {
  id: string;
  order_number: string | null;
  review_status: string | null;
  created_at: string;
  customers?: {
    company_name: string | null;
    full_name: string | null;
  } | null;
  qbo_invoices?: {
    invoice_number: string | null;
    payment_status: string | null;
  } | null;
  shipping_order_lines?: Array<{
    id: string;
    fulfillment_status: string | null;
  }>;
};

type ContainerSummary = {
  id: string;
  container_number: string | null;
  lifecycle_status: string | null;
  payment_status: string | null;
  created_at: string;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

export default async function InventoryOverviewPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const supabase = await createClient();
  const params = await searchParams;
  const activeTab = params.tab ?? "inventory";

  const [{ data: containers }, { data: containerLines }, { data: queueLines }, { data: orders }] = await Promise.all([
    supabase
      .from("containers")
      .select("id, container_number, lifecycle_status, payment_status, created_at")
      .order("created_at", { ascending: false })
      .limit(6),
    supabase
      .from("container_lines")
      .select(`
        product_id,
        ordered_qty,
        received_qty,
        on_order_qty,
        products (sku, canonical_name)
      `)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("shipping_order_lines")
      .select("approved_qty, fulfilled_qty, approval_status")
      .in("approval_status", ["APPROVED", "PARTIAL", "FULFILLED"]),
    supabase
      .from("shipping_orders")
      .select(`
        id,
        order_number,
        review_status,
        created_at,
        customers (company_name, full_name),
        qbo_invoices (invoice_number, payment_status),
        shipping_order_lines (id, fulfillment_status)
      `)
      .order("created_at", { ascending: false })
      .limit(6),
  ]);

  const activeContainers = (containers ?? []).filter((container) => ["ORDERED", "PRODUCTION", "INBOUND"].includes(container.lifecycle_status ?? ""));
  const containerLineSummaries = (containerLines ?? []) as ContainerLineSummary[];
  const queueLineSummaries = (queueLines ?? []) as QueueLineSummary[];
  const orderSummaries = (orders ?? []) as OrderSummary[];
  const containerSummaries = (containers ?? []) as ContainerSummary[];
  const physicalInventory = containerLineSummaries.reduce((sum, line) => sum + Number(line.received_qty ?? 0), 0);
  const incomingInventory = containerLineSummaries.reduce((sum, line) => sum + Number(line.on_order_qty ?? 0), 0);
  const openDemand = queueLineSummaries.reduce((sum, line) => sum + Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)), 0);
  const incomingLineSummaries = containerLineSummaries;

  const tabs = [
    { id: "inventory", label: "Inventory" },
    { id: "orders", label: "Orders" },
    { id: "containers", label: "Containers" },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Inventory</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Operations Overview</h1>
            <p className="mt-2 max-w-2xl text-sm text-[#5a5a5a]">
              Move between inventory, orders, and containers from one place so the workflow feels like a single operational hub.
            </p>
          </div>
          <Link href="/containers" className="btn-primary inline-flex">
            View Containers
          </Link>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <Link
                key={tab.id}
                href={`/inventory?tab=${tab.id}`}
                className={`rounded-full px-3 py-2 text-sm font-semibold transition ${isActive ? "bg-[#111827] text-white" : "bg-[#f3f4f6] text-[#374151]"}`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>

      {activeTab === "inventory" ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
              <p className="text-sm font-medium text-[#6b7280]">Physical Inventory</p>
              <p className="mt-2 text-3xl font-semibold text-[#111827]">{physicalInventory}</p>
            </div>
            <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
              <p className="text-sm font-medium text-[#6b7280]">Open Demand</p>
              <p className="mt-2 text-3xl font-semibold text-[#111827]">{openDemand}</p>
            </div>
            <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
              <p className="text-sm font-medium text-[#6b7280]">Incoming Containers</p>
              <p className="mt-2 text-3xl font-semibold text-[#111827]">{activeContainers.length}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-[#111827]">Incoming and on-order lines</h2>
              <p className="text-sm text-[#6b7280]">{incomingInventory} units on order</p>
            </div>

            {incomingLineSummaries.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
                No container lines are available yet.
              </div>
            ) : null}

            {incomingLineSummaries.length > 0 ? (
              <div className="space-y-3">
                {incomingLineSummaries.map((line, index) => {
                  const productName = line.products?.canonical_name ?? line.products?.sku ?? `Line ${index + 1}`;
                  return (
                    <div key={`${line.product_id ?? "line"}-${index}`} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-semibold text-[#111827]">{productName}</p>
                          <p className="text-[#6b7280]">Received {line.received_qty ?? 0} • On order {line.on_order_qty ?? 0}</p>
                        </div>
                        <div className="rounded-full bg-[#eef2f7] px-2.5 py-1 text-xs font-medium text-[#334155]">
                          Ordered {line.ordered_qty ?? 0}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {activeTab === "orders" ? (
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-[#111827]">Recent orders</h2>
            <Link href="/orders" className="text-sm font-semibold text-[#d50917] hover:underline">
              Open full orders view
            </Link>
          </div>

          {orderSummaries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
              No orders are available yet.
            </div>
          ) : null}

          {orderSummaries.length > 0 ? (
            <div className="space-y-3">
              {orderSummaries.map((order) => {
                const customerName = order.customers?.company_name ?? order.customers?.full_name ?? "Customer pending";
                const invoiceNumber = order.qbo_invoices?.invoice_number ?? order.order_number ?? "—";
                const openLineCount = (order.shipping_order_lines ?? []).filter((line) => (line.fulfillment_status ?? "PENDING") !== "FULFILLED").length;
                return (
                  <div key={order.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold text-[#111827]">{customerName}</p>
                        <p className="mt-1 text-sm text-[#5a5a5a]">Invoice #{invoiceNumber}</p>
                      </div>
                      <div className="text-sm text-[#374151]">
                        <p>{formatStatus(order.review_status)}</p>
                        <p className="mt-1">{openLineCount} open line{openLineCount === 1 ? "" : "s"}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {activeTab === "containers" ? (
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-[#111827]">Recent containers</h2>
            <Link href="/containers" className="text-sm font-semibold text-[#d50917] hover:underline">
              Open full containers view
            </Link>
          </div>

          {containerSummaries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
              No containers are available yet.
            </div>
          ) : null}

          {containerSummaries.length > 0 ? (
            <div className="space-y-3">
              {containerSummaries.map((container) => (
                <div key={container.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-[#111827]">{container.container_number ?? "Container"}</p>
                      <p className="mt-1 text-sm text-[#5a5a5a]">{formatStatus(container.lifecycle_status)}</p>
                    </div>
                    <div className="text-sm text-[#374151]">
                      <p>{formatStatus(container.payment_status)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
