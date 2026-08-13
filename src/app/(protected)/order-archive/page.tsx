import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type ArchiveEntry = {
  id: string;
  ordered_qty: number | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  approval_status: string | null;
  warehouse_status: string | null;
  fulfillment_status: string | null;
  priority: string | null;
  products?: {
    sku: string | null;
    canonical_name: string | null;
  } | null;
  shipping_orders?: {
    id: string;
    order_number: string | null;
    qbo_invoices?: {
      invoice_number: string | null;
      customers?: {
        company_name: string | null;
        full_name: string | null;
      } | null;
    } | null;
  } | null;
};

type DeniedCancelledRollupEntry = {
  id: string;
  reason_category: "setup_rollback" | "cancel_deny_rollback";
  invoice_number_normalized: string;
  item_code_normalized: string;
  reason_normalized: string;
  canonical_invoice_number: string;
  canonical_item_code: string;
  canonical_reason: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  actors: string[];
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString();
}

export default async function OrderArchivePage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const params = await searchParams;
  const searchText = String(params.search ?? "").trim().toLowerCase();

  const { data: archiveRows, error } = await supabase
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
      updated_at,
      products (sku, canonical_name),
      shipping_orders (
        id,
        order_number,
        qbo_invoices (
          invoice_number,
          customers (company_name, full_name)
        )
      )
    `)
    .order("updated_at", { ascending: false });

  const archiveEntries = ((archiveRows ?? []) as ArchiveEntry[]).filter((line) => {
    const fulfilled = Number(line.fulfilled_qty ?? 0) > 0 || line.fulfillment_status === "FULFILLED";
    if (!fulfilled) return false;
    if (!searchText) return true;

    const searchableText = [
      line.products?.sku,
      line.products?.canonical_name,
      line.shipping_orders?.order_number,
      line.shipping_orders?.qbo_invoices?.invoice_number,
      line.shipping_orders?.qbo_invoices?.customers?.company_name,
      line.shipping_orders?.qbo_invoices?.customers?.full_name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchableText.includes(searchText);
  });

  const lineIds = archiveEntries.map((line) => line.id);

  const { data: deniedCancelledRollupRows, error: deniedCancelledRollupError } = await supabase
    .from("order_history_reason_rollups")
    .select(`
      id,
      reason_category,
      invoice_number_normalized,
      item_code_normalized,
      reason_normalized,
      canonical_invoice_number,
      canonical_item_code,
      canonical_reason,
      first_seen_at,
      last_seen_at,
      occurrence_count,
      actors
    `)
    .eq("reason_category", "cancel_deny_rollback")
    .order("last_seen_at", { ascending: false });

  const deniedCancelledEntries = ((deniedCancelledRollupRows ?? []) as DeniedCancelledRollupEntry[]).filter((entry) => {
    if (!searchText) return true;

    const searchableText = [
      entry.canonical_invoice_number,
      entry.canonical_item_code,
      entry.canonical_reason,
      ...(entry.actors ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchableText.includes(searchText);
  });

  const { data: fulfillmentRows } = lineIds.length
    ? await supabase
        .from("fulfillments")
        .select("shipping_order_line_id, fulfilled_qty, shipment_number, carrier, tracking_number, created_at")
        .in("shipping_order_line_id", lineIds)
        .order("created_at", { ascending: false })
    : { data: [] };

  const fulfillmentByLine = (fulfillmentRows ?? []).reduce<Record<string, Array<{ shipment_number: string | null; tracking_number: string | null; carrier: string | null }>>>((acc, fulfillment) => {
    const lineId = String(fulfillment.shipping_order_line_id);
    if (!acc[lineId]) {
      acc[lineId] = [];
    }
    acc[lineId].push({
      shipment_number: fulfillment.shipment_number ?? null,
      tracking_number: fulfillment.tracking_number ?? null,
      carrier: fulfillment.carrier ?? null,
    });
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Order Archive</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">
          Historical support for previously fulfilled orders stays searchable without requiring any manual move step.
        </p>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <form method="GET" className="flex flex-wrap gap-3">
          <input
            name="search"
            defaultValue={searchText}
            placeholder="Search invoice, customer, SKU..."
            className="input min-w-[260px]"
          />
          <button type="submit" className="btn-secondary">Search</button>
        </form>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        {error ? (
          <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Unable to load archive history right now.</div>
        ) : null}

        {!error && archiveEntries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No fulfilled orders have been recorded yet.
          </div>
        ) : null}

        {!error && archiveEntries.length > 0 ? (
          <div className="space-y-3">
            {archiveEntries.map((line) => {
              const productName = line.products?.canonical_name ?? line.products?.sku ?? "Unmapped product";
              const customerName = line.shipping_orders?.qbo_invoices?.customers?.company_name
                ?? line.shipping_orders?.qbo_invoices?.customers?.full_name
                ?? "Customer pending";
              const invoiceNumber = line.shipping_orders?.qbo_invoices?.invoice_number ?? line.shipping_orders?.order_number ?? "—";
              const history = fulfillmentByLine[line.id] ?? [];
              const lastHistory = history[0];

              return (
                <div key={line.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-[#111827]">{productName}</p>
                      <p className="mt-1 text-sm text-[#5a5a5a]">{customerName}</p>
                      <p className="mt-1 text-sm text-[#5a5a5a]">Invoice #{invoiceNumber}</p>
                    </div>
                    <div className="text-sm text-[#374151]">
                      <p>Fulfilled {line.fulfilled_qty ?? 0}</p>
                      <p className="mt-1">Status {formatStatus(line.fulfillment_status)}</p>
                    </div>
                  </div>

                  {lastHistory ? (
                    <div className="mt-3 rounded-lg border border-[#e5e7eb] bg-white p-3 text-sm text-[#374151]">
                      {lastHistory.shipment_number ? <p>Shipment #{lastHistory.shipment_number}</p> : null}
                      {lastHistory.tracking_number ? <p>Tracking {lastHistory.tracking_number}</p> : null}
                      {lastHistory.carrier ? <p>Carrier {lastHistory.carrier}</p> : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-[#111827]">Denied & Cancelled History</h2>
            <p className="mt-1 text-sm text-[#5a5a5a]">
              Built from rollback history events categorized as cancel/deny only. This section never reads active demand or inventory tables.
            </p>
          </div>
          <div className="rounded-lg border border-[#d1d5db] bg-[#f9fafb] px-3 py-2 text-xs text-[#374151]">
            Business-history events: {deniedCancelledEntries.length}
          </div>
        </div>

        {deniedCancelledRollupError ? (
          <div className="mt-4 rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">
            Unable to load denied/cancelled historical rollups right now.
          </div>
        ) : null}

        {!deniedCancelledRollupError && deniedCancelledEntries.length === 0 ? (
          <div className="mt-4 rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No denied/cancelled rollback events matched this filter.
          </div>
        ) : null}

        {!deniedCancelledRollupError && deniedCancelledEntries.length > 0 ? (
          <div className="mt-4 space-y-3">
            {deniedCancelledEntries.map((entry) => (
              <div key={entry.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-[#111827]">Invoice #{entry.canonical_invoice_number}</p>
                    <p className="mt-1 text-sm text-[#374151]">Item {entry.canonical_item_code}</p>
                    <p className="mt-1 text-sm text-[#5a5a5a]">{entry.canonical_reason}</p>
                  </div>
                  <div className="text-right text-sm text-[#374151]">
                    <p>Occurrences {entry.occurrence_count}</p>
                    <p className="mt-1">First seen {formatDate(entry.first_seen_at)}</p>
                    <p className="mt-1">Last seen {formatDate(entry.last_seen_at)}</p>
                  </div>
                </div>
                {entry.actors.length > 0 ? (
                  <div className="mt-3 rounded-lg border border-[#e5e7eb] bg-white p-3 text-sm text-[#374151]">
                    Actor(s): {entry.actors.join(", ")}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
