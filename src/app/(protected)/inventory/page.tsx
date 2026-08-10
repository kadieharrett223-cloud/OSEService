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

export default async function InventoryOverviewPage() {
  const supabase = await createClient();

  const [{ data: containers }, { data: containerLines }, { data: queueLines }] = await Promise.all([
    supabase.from("containers").select("id, lifecycle_status").order("created_at", { ascending: false }),
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
  ]);

  const activeContainers = (containers ?? []).filter((container) => ["ORDERED", "PRODUCTION", "INBOUND"].includes(container.lifecycle_status ?? ""));
  const containerLineSummaries = (containerLines ?? []) as ContainerLineSummary[];
  const queueLineSummaries = (queueLines ?? []) as QueueLineSummary[];
  const physicalInventory = containerLineSummaries.reduce((sum, line) => sum + Number(line.received_qty ?? 0), 0);
  const incomingInventory = containerLineSummaries.reduce((sum, line) => sum + Number(line.on_order_qty ?? 0), 0);
  const openDemand = queueLineSummaries.reduce((sum, line) => sum + Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)), 0);
  const incomingLineSummaries = containerLineSummaries;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Inventory</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Inventory Overview</h1>
            <p className="mt-2 max-w-2xl text-sm text-[#5a5a5a]">
              This shell now reflects the current flow of incoming containers, received inventory, and open demand so the new workflow has a practical starting point.
            </p>
          </div>
          <Link href="/containers" className="btn-primary inline-flex">
            View Containers
          </Link>
        </div>
      </div>

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
    </div>
  );
}
