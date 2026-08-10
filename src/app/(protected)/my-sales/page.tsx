import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { canViewMySales } from "@/lib/roles";
import { redirect } from "next/navigation";

type SalesOrder = {
  id: string;
  review_status: string | null;
  promised_ship_date: string | null;
  tracking_number: string | null;
  carrier: string | null;
  qbo_invoices?: {
    invoice_number: string | null;
    payment_status: string | null;
    customers?: {
      full_name: string | null;
      company_name: string | null;
    } | null;
  } | null;
  shipping_order_lines?: Array<{
    id: string;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    approval_status: string | null;
    warehouse_status: string | null;
    fulfillment_status: string | null;
    queue_position_start: number | null;
    products?: {
      sku: string | null;
      canonical_name: string | null;
    } | null;
    inventory_allocations?: Array<{
      source_type: string | null;
      containers?: {
        container_number: string | null;
        lifecycle_status: string | null;
        eta_confirmed_date: string | null;
        eta_estimated_date: string | null;
      } | null;
    }>;
  }>;
};

type FilterValue = "all" | "waiting" | "warehouse" | "shipped" | "fulfilled";

function normalizeFilter(value: string | undefined): FilterValue {
  if (value === "waiting" || value === "warehouse" || value === "shipped" || value === "fulfilled") return value;
  return "all";
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function lineAssignment(line: NonNullable<SalesOrder["shipping_order_lines"]>[number]) {
  const allocations = line.inventory_allocations ?? [];
  if (allocations.length === 0) return "Unassigned";
  return allocations.map((allocation) => {
    if (allocation.source_type === "FLOOR") return "On Floor";
    const container = allocation.containers?.container_number ?? "Container";
    const status = formatStatus(allocation.containers?.lifecycle_status);
    const eta = formatDate(allocation.containers?.eta_confirmed_date ?? allocation.containers?.eta_estimated_date);
    return `${container} · ${status} · ETA ${eta}`;
  }).join("; ");
}

function orderStage(order: SalesOrder): FilterValue {
  const lines = order.shipping_order_lines ?? [];
  const allFulfilled = lines.length > 0 && lines.every((line) => line.fulfillment_status === "FULFILLED");
  const anyShipped = lines.some((line) => line.fulfillment_status === "PARTIALLY_FULFILLED");
  const anyWarehouse = lines.some((line) => line.warehouse_status === "IN_WAREHOUSE" || line.warehouse_status === "PICKED" || line.warehouse_status === "READY_TO_SHIP");

  if (allFulfilled) return "fulfilled";
  if (anyShipped) return "shipped";
  if (anyWarehouse) return "warehouse";
  return "waiting";
}

export default async function MySalesPage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string }> }) {
  const user = await requireUser();
  if (!canViewMySales(user.fullName)) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const query = String(params.q ?? "").trim().toLowerCase();
  const filter = normalizeFilter(params.filter);

  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("shipping_orders")
    .select(`
      id,
      review_status,
      promised_ship_date,
      tracking_number,
      carrier,
      qbo_invoices (
        invoice_number,
        payment_status,
        customers (full_name, company_name)
      ),
      shipping_order_lines (
        id,
        approved_qty,
        fulfilled_qty,
        approval_status,
        warehouse_status,
        fulfillment_status,
        queue_position_start,
        products (sku, canonical_name),
        inventory_allocations (
          source_type,
          containers (container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date)
        )
      )
    `)
    .order("created_at", { ascending: false })
    .limit(300);

  const orders = ((rows ?? []) as SalesOrder[])
    .filter((order) => order.qbo_invoices?.payment_status === "Paid")
    .filter((order) => {
      const customer = `${order.qbo_invoices?.customers?.full_name ?? ""} ${order.qbo_invoices?.customers?.company_name ?? ""}`.toLowerCase();
      const invoice = `${order.qbo_invoices?.invoice_number ?? ""}`.toLowerCase();
      if (query && !customer.includes(query) && !invoice.includes(query)) return false;
      if (filter !== "all" && orderStage(order) !== filter) return false;
      return true;
    });

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">My Sales</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">Read-only status for paid customers: queue position, assignment, ETA, warehouse status, and tracking.</p>
      </div>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <form method="get" action="/my-sales" className="flex flex-wrap gap-2">
          <input name="q" defaultValue={params.q ?? ""} placeholder="Search customer or invoice" className="input min-w-[240px] flex-1" />
          <select name="filter" defaultValue={filter} className="select min-w-[170px]">
            <option value="all">All</option>
            <option value="waiting">Waiting</option>
            <option value="warehouse">In Warehouse</option>
            <option value="shipped">Shipped</option>
            <option value="fulfilled">Fulfilled</option>
          </select>
          <button type="submit" className="btn-secondary">Apply</button>
          <Link href="/my-sales" className="btn-ghost">Reset</Link>
        </form>
      </section>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        {error ? (
          <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Unable to load sales tracking right now.</div>
        ) : null}

        {!error && orders.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">No paid customer orders match this filter.</div>
        ) : null}

        {!error && orders.length > 0 ? (
          <div className="space-y-4">
            {orders.map((order) => {
              const customer = order.qbo_invoices?.customers?.company_name ?? order.qbo_invoices?.customers?.full_name ?? "Customer pending";
              const invoice = order.qbo_invoices?.invoice_number ?? "—";
              const stage = orderStage(order);
              return (
                <details key={order.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <summary className="list-none cursor-pointer">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-[#111827]">Invoice {invoice}</p>
                        <p className="text-sm text-[#5a5a5a]">{customer}</p>
                      </div>
                      <div className="text-right text-sm text-[#475569]">
                        <p className="font-semibold">{formatStatus(stage.toUpperCase())}</p>
                        <p>Scheduled: {formatDate(order.promised_ship_date)}</p>
                        <p>Tracking: {order.tracking_number ?? "—"}</p>
                      </div>
                    </div>
                  </summary>

                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[840px] text-left text-xs">
                      <thead>
                        <tr className="border-b border-[#dbe3ee] text-[#64748b]">
                          <th className="px-2 py-1">SKU</th>
                          <th className="px-2 py-1">Qty Remaining</th>
                          <th className="px-2 py-1">Queue Position</th>
                          <th className="px-2 py-1">Assigned</th>
                          <th className="px-2 py-1">Warehouse</th>
                          <th className="px-2 py-1">Fulfillment</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(order.shipping_order_lines ?? []).map((line) => {
                          const remaining = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
                          return (
                            <tr key={line.id} className="border-b border-[#edf2f7]">
                              <td className="px-2 py-1">{line.products?.sku ?? line.products?.canonical_name ?? "SKU"}</td>
                              <td className="px-2 py-1">{remaining}</td>
                              <td className="px-2 py-1">{line.queue_position_start ?? "—"}</td>
                              <td className="px-2 py-1">{lineAssignment(line)}</td>
                              <td className="px-2 py-1">{formatStatus(line.warehouse_status)}</td>
                              <td className="px-2 py-1">{formatStatus(line.fulfillment_status)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-3">
                    <Link href={`/orders/${order.id}`} className="text-sm font-semibold text-[#2563eb] hover:underline">Open shipping order</Link>
                  </div>
                </details>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
