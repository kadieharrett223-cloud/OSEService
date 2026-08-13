import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { acceptNewOrderAction, updateDeniedArchiveReasonAction } from "./actions";

type OrderSummary = {
  id: string;
  order_number: string | null;
  legacy_customer_name: string | null;
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

type DeniedInvoiceRollup = {
  id: string;
  reason_category: "cancel_deny_rollback" | "setup_rollback";
  canonical_invoice_number: string;
  canonical_item_code: string;
  canonical_reason: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
};

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

function formatDate(value: string | null | undefined) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; message?: string; error?: string }>;
}) {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const params = await searchParams;
  const activeTab = params.tab ?? "review";
  const searchText = String(params.q ?? "").trim().toLowerCase();

  const { count: deniedCountRaw } = await supabase
    .from("order_history_reason_rollups")
    .select("id", { count: "exact", head: true })
    .eq("reason_category", "cancel_deny_rollback");

  const deniedCount = Number(deniedCountRaw ?? 0);

  const { data: deniedRollupRows, error: deniedRollupError } = activeTab === "denied"
    ? await supabase
        .from("order_history_reason_rollups")
        .select(`
          id,
          reason_category,
          canonical_invoice_number,
          canonical_item_code,
          canonical_reason,
          first_seen_at,
          last_seen_at,
          occurrence_count
        `)
        .eq("reason_category", "cancel_deny_rollback")
        .order("last_seen_at", { ascending: false })
    : { data: [], error: null };

  const deniedSummaries = ((deniedRollupRows ?? []) as DeniedInvoiceRollup[]).filter((entry) => {
    if (!searchText) return true;

    const searchable = [
      entry.canonical_invoice_number,
      entry.canonical_item_code,
      entry.canonical_reason,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchable.includes(searchText);
  });

  const { data: orders, error } = await supabase
    .from("shipping_orders")
    .select(`
      id,
      order_number,
      legacy_customer_name,
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

  const allOrders = (orders ?? []) as OrderSummary[];

  const deniedCustomerByInvoice = new Map<string, string>();
  for (const order of allOrders) {
    const customerName = order.customers?.company_name
      ?? order.customers?.full_name
      ?? order.legacy_customer_name
      ?? null;

    if (!customerName) continue;

    const invoiceNumber = order.qbo_invoices?.invoice_number ?? order.order_number ?? null;
    if (!invoiceNumber) continue;

    deniedCustomerByInvoice.set(invoiceNumber.toUpperCase(), customerName);
  }

  function matchesTab(order: OrderSummary, tabId: string) {
    const lines = order.shipping_order_lines ?? [];
    const hasLines = lines.length > 0;
    const allFulfilled = hasLines && lines.every((line) => line.fulfillment_status === "FULFILLED");
    const anyApproved = lines.some((line) => line.approval_status === "APPROVED" || line.approval_status === "PARTIAL");
    const anyWarehouse = lines.some((line) => line.warehouse_status === "IN_WAREHOUSE" || line.warehouse_status === "PICKED" || line.warehouse_status === "READY_TO_SHIP");
    const anyShipped = lines.some((line) => line.fulfillment_status === "PARTIALLY_FULFILLED");
    const anyReview = lines.some((line) => line.approval_status === "PENDING_REVIEW");

    switch (tabId) {
      case "review":
        return order.review_status === "PENDING_REVIEW" || !hasLines || anyReview;
      case "accepted":
        return anyApproved && !anyWarehouse && !anyShipped && !allFulfilled;
      case "warehouse":
        return anyWarehouse && !allFulfilled;
      case "shipped":
        return anyShipped && !allFulfilled;
      case "fulfilled":
        return allFulfilled || order.review_status === "FULFILLED";
      default:
        return true;
    }
  }

  const orderSummaries = allOrders.filter((order) => {
    if (!matchesTab(order, activeTab)) return false;
    if (!searchText) return true;

    const searchable = [
      order.order_number,
      order.legacy_customer_name,
      order.customers?.company_name,
      order.customers?.full_name,
      order.qbo_invoices?.invoice_number,
      ...(order.shipping_order_lines ?? []).flatMap((line) => [line.products?.sku, line.products?.canonical_name]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchable.includes(searchText);
  });

  const tabCounts = {
    review: allOrders.filter((order) => matchesTab(order, "review")).length,
    accepted: allOrders.filter((order) => matchesTab(order, "accepted")).length,
    warehouse: allOrders.filter((order) => matchesTab(order, "warehouse")).length,
    shipped: allOrders.filter((order) => matchesTab(order, "shipped")).length,
    fulfilled: allOrders.filter((order) => matchesTab(order, "fulfilled")).length,
    denied: deniedCount,
  };

  const tabs = [
    { id: "review", label: "New / Review" },
    { id: "accepted", label: "Accepted" },
    { id: "warehouse", label: "In Warehouse" },
    { id: "shipped", label: "Shipped" },
    { id: "fulfilled", label: "Fulfilled" },
    { id: "denied", label: "Denied" },
  ];

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
          <div className="flex gap-2">
            <Link href="/orders/import" className="btn-primary inline-flex">Bulk Upload Orders</Link>
            <Link href="/schedule" className="btn-secondary inline-flex">Open Schedule</Link>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <form method="GET" className="mb-4 flex flex-wrap gap-2">
          <input type="hidden" name="tab" value={activeTab} />
          <input
            name="q"
            defaultValue={searchText}
            placeholder="Filter by item number, invoice, or customer"
            className="input min-w-[280px] flex-1"
          />
          <button type="submit" className="btn-secondary">Filter</button>
          <Link href={`/orders?tab=${activeTab}`} className="btn-ghost">Clear</Link>
        </form>
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <Link
                key={tab.id}
                href={searchText ? `/orders?tab=${tab.id}&q=${encodeURIComponent(searchText)}` : `/orders?tab=${tab.id}`}
                className={`rounded-full px-3 py-2 text-sm font-semibold ${isActive ? "bg-[#111827] text-white" : "bg-[#f3f4f6] text-[#374151]"}`}
              >
                {tab.label} ({tabCounts[tab.id as keyof typeof tabCounts] ?? 0})
              </Link>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        {params.message ? (
          <div className="mb-4 rounded-lg border border-[#b7e4c7] bg-[#ecfdf3] p-3 text-sm text-[#166534]">
            {params.message}
          </div>
        ) : null}

        {params.error ? (
          <div className="mb-4 rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">
            {params.error}
          </div>
        ) : null}

        {activeTab !== "denied" && error ? (
          <div className="mb-4 rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">
            Unable to load orders right now.
          </div>
        ) : null}

        {activeTab === "denied" && deniedRollupError ? (
          <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">
            Unable to load denied archive rows right now.
          </div>
        ) : null}

        {activeTab !== "denied" && orderSummaries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            <p>{searchText ? "No orders match that filter in this status." : "No orders match this status yet."}</p>
            {activeTab === "review" && tabCounts.accepted > 0 ? (
              <p className="mt-2">
                {tabCounts.accepted} approved open order{tabCounts.accepted === 1 ? "" : "s"} are available under{" "}
                <Link href="/orders?tab=accepted" className="font-semibold text-[#2563eb] hover:underline">Accepted</Link>.
              </p>
            ) : null}
          </div>
        ) : null}

        {activeTab === "denied" && !deniedRollupError && deniedSummaries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            <p>{searchText ? "No denied invoices match that filter." : "No denied invoices are archived yet."}</p>
          </div>
        ) : null}

        {activeTab !== "denied" && orderSummaries.length > 0 ? (
          <div className="space-y-3">
            {orderSummaries.map((order) => {
              const customerName = order.customers?.company_name ?? order.customers?.full_name ?? order.legacy_customer_name ?? "Customer pending";
              const invoiceNumber = order.qbo_invoices?.invoice_number ?? order.order_number ?? "—";
              const salesperson = parseSalesperson(order.qbo_invoices?.raw_payload);
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
                    {activeTab === "review" ? (
                      <form action={acceptNewOrderAction}>
                        <input type="hidden" name="orderId" value={order.id} />
                        <button type="submit" className="btn-primary inline-flex">Accept Order</button>
                      </form>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {activeTab === "denied" && !deniedRollupError && deniedSummaries.length > 0 ? (
          <div className="space-y-3">
            {deniedSummaries.map((entry) => {
              const customerName = deniedCustomerByInvoice.get(entry.canonical_invoice_number.toUpperCase()) ?? "Customer not available";

              return (
                <div key={entry.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-[#111827]">Invoice #{entry.canonical_invoice_number}</p>
                      <p className="mt-1 text-sm text-[#374151]">{customerName}</p>
                      <p className="mt-1 text-sm text-[#374151]">Item {entry.canonical_item_code}</p>
                      <p className="mt-1 text-sm text-[#5a5a5a]">Occurrences {entry.occurrence_count}</p>
                      <p className="mt-1 text-xs text-[#6b7280]">First seen {formatDate(entry.first_seen_at)} • Last seen {formatDate(entry.last_seen_at)}</p>
                    </div>
                    <span className="rounded-full bg-[#fee2e2] px-2.5 py-1 text-xs font-semibold text-[#b91c1c]">Denied</span>
                  </div>

                  <form action={updateDeniedArchiveReasonAction} className="mt-4 space-y-2">
                    <input type="hidden" name="rollup_id" value={entry.id} />
                    <input type="hidden" name="return_path" value={searchText ? `/orders?tab=denied&q=${encodeURIComponent(searchText)}` : "/orders?tab=denied"} />
                    <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-[#6b7280]" htmlFor={`reason-${entry.id}`}>
                      Denied reason (editable)
                    </label>
                    <textarea
                      id={`reason-${entry.id}`}
                      name="canonical_reason"
                      defaultValue={entry.canonical_reason}
                      className="w-full rounded-lg border border-[#d1d5db] bg-white px-3 py-2 text-sm text-[#111827] focus:border-[#111827] focus:outline-none"
                      rows={2}
                    />
                    <div className="flex flex-wrap gap-2">
                      <button type="submit" className="btn-secondary">Save reason</button>
                    </div>
                  </form>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
