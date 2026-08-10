import { createClient } from "@/lib/supabase/server";
import { fulfillQueueLineAction } from "./actions";

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

export default async function ProductQueuePage() {
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
      shipping_orders (id, order_number)
    `)
    .in("approval_status", ["APPROVED", "PARTIAL", "FULFILLED"])
    .order("queue_position_start", { ascending: true, nullsFirst: false });

  const queueEntries = (queueRows ?? []) as QueueEntry[];
  const openDemand = queueEntries.reduce((sum, line) => sum + Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)), 0);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Product Queue</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">
          Approved shipping lines appear here in queue order, with priority and fulfillment state reflected on each line.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Open Demand</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{openDemand}</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Tracked Lines</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{queueEntries.length}</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Priority Mix</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{queueEntries.some((line) => line.priority === "HIGH") ? "High focus" : "Standard"}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-[#111827]">Queue entries</h2>
          <div className="rounded-full bg-[#eef2f7] px-3 py-1 text-sm font-medium text-[#334155]">
            {queueEntries.length} active
          </div>
        </div>

        {error ? (
          <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Unable to load queue data right now.</div>
        ) : null}

        {!error && queueEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No approved queue lines are available yet.
          </div>
        ) : null}

        {!error && queueEntries.length > 0 ? (
          <div className="space-y-3">
            {queueEntries.map((line) => {
              const productName = line.products?.canonical_name ?? line.products?.sku ?? "Unmapped product";
              const orderNumber = line.shipping_orders?.order_number ?? "—";
              const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
              return (
                <div key={line.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-[#111827]">{productName}</p>
                      <p className="mt-1 text-sm text-[#5a5a5a]">Order #{orderNumber}</p>
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
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <form action={fulfillQueueLineAction}>
                      <input type="hidden" name="lineId" value={line.id} />
                      <input type="hidden" name="quantity" value={Math.max(1, Math.min(Number(line.approved_qty ?? 0), Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)))} />
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
