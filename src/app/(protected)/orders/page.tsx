import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

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
    invoice_date: string | null;
    raw_payload?: unknown;
  } | null;
  shipping_order_lines?: Array<{
    id: string;
    approval_status: string | null;
    warehouse_status: string | null;
    fulfillment_status: string | null;
    priority: string | null;
    ordered_qty: number | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    products?: {
      sku: string | null;
      canonical_name: string | null;
    } | null;
  }>;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(status: string | null | undefined) {
  if (status === "APPROVED" || status === "FULFILLED") return "bg-[#e7f7ed] text-[#1b7a43]";
  if (status === "HOLD") return "bg-[#fee2e2] text-[#b91c1c]";
  if (status === "PENDING_REVIEW") return "bg-[#fef3c7] text-[#92400e]";
  return "bg-[#eef2f7] text-[#334155]";
}

function parseSalesperson(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const payload = rawPayload as Record<string, unknown>;
  const salesrep = payload.SalesRepRef as { name?: unknown } | undefined;
  return typeof salesrep?.name === "string" ? salesrep.name : null;
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const supabase = await createClient();
  const params = await searchParams;
  const activeTab = params.tab ?? "new";

  const { data: orders, error } = await supabase
    .from("shipping_orders")
    .select(`
      id,
      order_number,
      review_status,
      created_at,
      customers (company_name, full_name),
      qbo_invoices (invoice_number, payment_status, invoice_date, raw_payload),
      shipping_order_lines (
        id,
        approval_status,
        warehouse_status,
        fulfillment_status,
        priority,
        ordered_qty,
        approved_qty,
        fulfilled_qty,
        products (sku, canonical_name)
      )
    `)
    .order("created_at", { ascending: false });

  const orderSummaries = ((orders ?? []) as OrderSummary[]).filter((order) => {
    const lineStatuses = (order.shipping_order_lines ?? []).map((line) => line.fulfillment_status ?? "PENDING");
    const hasFulfilled = lineStatuses.includes("FULFILLED");
    const hasOpen = lineStatuses.some((status) => status !== "FULFILLED");

    switch (activeTab) {
      case "accepted":
        return (order.review_status === "APPROVED" || (order.shipping_order_lines ?? []).some((line) => line.approval_status === "APPROVED")) && hasOpen && !hasFulfilled;
      case "warehouse":
        return (order.shipping_order_lines ?? []).some((line) => line.warehouse_status === "IN_WAREHOUSE" || line.warehouse_status === "PICKED" || line.warehouse_status === "READY_TO_SHIP") && hasOpen;
      case "shipped":
        return (order.shipping_order_lines ?? []).some((line) => line.fulfillment_status === "PARTIALLY_FULFILLED" || line.fulfillment_status === "FULFILLED") && hasOpen;
      case "fulfilled":
        return (!hasOpen && (order.shipping_order_lines ?? []).length > 0) || (order.review_status === "FULFILLED");
      case "new":
      default:
        return order.review_status === "PENDING_REVIEW" || (order.shipping_order_lines ?? []).length === 0;
    }
  });

  const tabs = [
    { id: "new", label: "New" },
    { id: "accepted", label: "Accepted / Queue" },
    { id: "warehouse", label: "In Warehouse" },
    { id: "shipped", label: "Shipped" },
    { id: "fulfilled", label: "Fulfilled" },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Inventory</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Orders</h1>
            <p className="mt-2 max-w-2xl text-sm text-[#5a5a5a]">
              Shipping review and order fulfillment now operate as a single operational screen under Inventory.
            </p>
          </div>
          <Link href="/orders/new" className="btn-primary inline-flex">
            Create Order View
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
                href={`/orders?tab=${tab.id}`}
                className={`rounded-full px-3 py-2 text-sm font-semibold ${isActive ? "bg-[#111827] text-white" : "bg-[#f3f4f6] text-[#374151]"}`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        {orderSummaries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No orders match this status yet.
          </div>
        ) : null}

        {orderSummaries.length > 0 ? (
          <div className="space-y-3">
            {orderSummaries.map((order) => {
              const customerName = order.customers?.company_name ?? order.customers?.full_name ?? "Customer pending";
              const invoiceNumber = order.qbo_invoices?.invoice_number ?? order.order_number ?? "—";
              const salesperson = parseSalesperson(order.qbo_invoices?.raw_payload);
              const firstLine = order.shipping_order_lines?.[0];
              const openLineCount = (order.shipping_order_lines ?? []).filter((line) => (line.fulfillment_status ?? "PENDING") !== "FULFILLED").length;
              return (
                <div key={order.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-[#111827]">{customerName}</p>
                      <p className="mt-1 text-sm text-[#5a5a5a]">Invoice #{invoiceNumber}</p>
                      {salesperson ? <p className="mt-1 text-sm text-[#5a5a5a]">Salesperson {salesperson}</p> : null}
                    </div>
                    <div className="text-sm text-[#374151]">
                      <p>{order.qbo_invoices?.payment_status ?? "Pending"}</p>
                      <p className="mt-1">{openLineCount} open line{openLineCount === 1 ? "" : "s"}</p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {(order.shipping_order_lines ?? []).slice(0, 3).map((line) => (
                      <span key={line.id} className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(line.approval_status)}`}>
                        {line.products?.sku ?? "SKU"}: {line.approval_status ?? "PENDING"}
                      </span>
                    ))}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href={`/orders/${order.id}`} className="btn-secondary inline-flex">Open order</Link>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
