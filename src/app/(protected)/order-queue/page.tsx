import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { fulfillQueueLineAction } from "@/app/(protected)/product-queue/actions";

type QueueEntry = {
  id: string;
  ordered_qty: number | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  approval_status: string | null;
  warehouse_status: string | null;
  fulfillment_status: string | null;
  priority: string | null;
  queue_position_start: number | null;
  queue_position_count: number | null;
  products?: {
    sku: string | null;
    canonical_name: string | null;
  } | null;
  shipping_orders?: {
    id: string;
    order_number: string | null;
    legacy_customer_name: string | null;
    qbo_invoices?: {
      invoice_number: string | null;
      customers?: {
        company_name: string | null;
        full_name: string | null;
      } | null;
    } | null;
  } | null;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(value: string | null | undefined) {
  if (value === "APPROVED" || value === "FULFILLED") return "bg-[#e7f7ed] text-[#1b7a43]";
  if (value === "PARTIAL") return "bg-[#eef2f7] text-[#334155]";
  if (value === "HOLD") return "bg-[#fee2e2] text-[#b91c1c]";
  return "bg-[#fef3c7] text-[#92400e]";
}

function formatCurrency(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(numeric)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(numeric);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default async function OrderQueuePage() {
  const supabase = await createClient();
  const { data: queueRows, error } = await supabase
    .from("shipping_order_lines")
    .select(`
      id,
      ordered_qty,
      approved_qty,
      fulfilled_qty,
      approval_status,
      warehouse_status,
      fulfillment_status,
      priority,
      queue_position_start,
      queue_position_count,
      products (sku, canonical_name),
      shipping_orders (
        id,
        order_number,
        legacy_customer_name,
        qbo_invoices (
          invoice_number,
          customers (company_name, full_name)
        )
      )
    `)
    .in("approval_status", ["APPROVED", "PARTIAL", "FULFILLED"])
    .order("queue_position_start", { ascending: true, nullsFirst: false });

  const queueEntries = (queueRows ?? []) as QueueEntry[];
  const openDemand = queueEntries.reduce((sum, line) => sum + Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)), 0);
  const lineIds = queueEntries.map((line) => line.id);
  const { data: allocationRows } = lineIds.length
    ? await supabase
        .from("inventory_allocations")
        .select("shipping_order_line_id, quantity, source_type, container_id, containers (container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date)")
        .in("shipping_order_line_id", lineIds)
    : { data: [] };

  const allocationsByLine = (allocationRows ?? []).reduce<Record<string, Array<{ quantity: number; source_type: string; container_number: string | null; lifecycle_status: string | null; eta: string | null }>>>((acc, allocation) => {
    const lineId = String((allocation as { shipping_order_line_id?: string | null }).shipping_order_line_id ?? "");
    if (!lineId) {
      return acc;
    }
    if (!acc[lineId]) {
      acc[lineId] = [];
    }
    acc[lineId].push({
      quantity: Number((allocation as { quantity?: number | null }).quantity ?? 0),
      source_type: String((allocation as { source_type?: string | null }).source_type ?? "FLOOR"),
      container_number: ((allocation as { containers?: { container_number?: string | null } | null }).containers?.container_number) ?? null,
      lifecycle_status: ((allocation as { containers?: { lifecycle_status?: string | null } | null }).containers?.lifecycle_status) ?? null,
      eta: ((allocation as { containers?: { eta_confirmed_date?: string | null; eta_estimated_date?: string | null } | null }).containers?.eta_confirmed_date)
        ?? ((allocation as { containers?: { eta_confirmed_date?: string | null; eta_estimated_date?: string | null } | null }).containers?.eta_estimated_date)
        ?? null,
    });
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Order Queue</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">
          Approved customer orders stay here until they are fully fulfilled or moved into historical review.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Open demand</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{openDemand}</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Active lines</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{queueEntries.length}</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Priority mix</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{queueEntries.some((line) => line.priority === "HIGH") ? "High focus" : "Standard"}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        {error ? (
          <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Unable to load the open order queue right now.</div>
        ) : null}

        {!error && queueEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No approved open orders are available yet.
          </div>
        ) : null}

        {!error && queueEntries.length > 0 ? (
          <div className="space-y-3">
            {queueEntries.map((line) => {
              const productName = line.products?.canonical_name ?? line.products?.sku ?? "Unmapped product";
              const customerName = line.shipping_orders?.qbo_invoices?.customers?.company_name
                ?? line.shipping_orders?.qbo_invoices?.customers?.full_name
                ?? line.shipping_orders?.legacy_customer_name
                ?? "Customer pending";
              const invoiceNumber = line.shipping_orders?.qbo_invoices?.invoice_number ?? line.shipping_orders?.order_number ?? "—";
              const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
              const allocations = allocationsByLine[line.id] ?? [];

              return (
                <div key={line.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-[#111827]">{productName}</p>
                      <p className="mt-1 text-sm text-[#5a5a5a]">{customerName}</p>
                      <p className="mt-1 text-sm text-[#5a5a5a]">Invoice #{invoiceNumber}</p>
                    </div>
                    <div className="text-sm text-[#374151]">
                      <p>Approved {line.approved_qty ?? 0}</p>
                      <p className="mt-1">Remaining {remainingQty}</p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(line.approval_status)}`}>
                      Approval: {formatStatus(line.approval_status)}
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(line.fulfillment_status)}`}>
                      Fulfillment: {formatStatus(line.fulfillment_status)}
                    </span>
                    <span className="rounded-full bg-[#eef2f7] px-2.5 py-1 text-xs font-medium text-[#334155]">
                      Priority: {line.priority ?? "Normal"}
                    </span>
                    <span className="rounded-full bg-[#eef2f7] px-2.5 py-1 text-xs font-medium text-[#334155]">
                      Queue: {line.queue_position_start ?? "—"}
                    </span>
                    <span className="rounded-full bg-[#eef2f7] px-2.5 py-1 text-xs font-medium text-[#334155]">
                      Warehouse: {formatStatus(line.warehouse_status)}
                    </span>
                  </div>

                  {allocations.length > 0 ? (
                    <div className="mt-3 rounded-lg border border-[#d7f7e2] bg-[#f1fdf5] p-3 text-sm text-[#0f6f35]">
                      Allocated {allocations.map((allocation) => {
                        if (allocation.source_type === "FLOOR") {
                          return `${allocation.quantity} from On Floor`;
                        }

                        if (allocation.source_type === "CONTAINER") {
                          const number = allocation.container_number ?? "Container";
                          const status = formatStatus(allocation.lifecycle_status);
                          const eta = formatDate(allocation.eta);
                          return `${allocation.quantity} from ${number} (${status} · ETA ${eta})`;
                        }

                        return `${allocation.quantity} from Unassigned`;
                      }).join("; ")}
                    </div>
                  ) : (
                    <div className="mt-3 rounded-lg border border-[#f1e7bf] bg-[#fffbeb] p-3 text-sm text-[#92400e]">
                      Unassigned: no inventory source selected.
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link href={`/orders/${line.shipping_orders?.id ?? ""}`} className="btn-secondary">Open Invoice</Link>
                    <form action={fulfillQueueLineAction}>
                      <input type="hidden" name="lineId" value={line.id} />
                      <input type="hidden" name="quantity" value={Math.max(1, Math.min(Number(line.approved_qty ?? 0), Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0))))} />
                      <button type="submit" className="btn-primary">Fulfill</button>
                    </form>
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
