import { createClient } from "@/lib/supabase/server";

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
        first_name: string | null;
        last_name: string | null;
      } | null;
    } | null;
  } | null;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

export default async function OrderArchivePage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const supabase = await createClient();
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
          customers (company_name, first_name, last_name)
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
      line.shipping_orders?.qbo_invoices?.customers?.first_name,
      line.shipping_orders?.qbo_invoices?.customers?.last_name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchableText.includes(searchText);
  });

  const lineIds = archiveEntries.map((line) => line.id);
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
                ?? [line.shipping_orders?.qbo_invoices?.customers?.first_name, line.shipping_orders?.qbo_invoices?.customers?.last_name].filter(Boolean).join(" ")
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
    </div>
  );
}
