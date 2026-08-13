import Link from "next/link";
import { createProductAction } from "@/app/(protected)/inventory/actions";
import { AddProductModal } from "@/app/(protected)/inventory/add-product-modal";
import { CustomerDemandDropdown } from "@/app/(protected)/inventory/customer-demand-dropdown";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type ProductRow = {
  id: string;
  sku: string | null;
  canonical_name: string | null;
};

type InventoryTransactionRow = {
  product_id: string | null;
  bucket: string | null;
  delta: number | null;
};

type ContainerLineRow = {
  product_id: string | null;
  on_order_qty: number | null;
  container_id: string | null;
  containers?: {
    container_number: string | null;
    eta_confirmed_date: string | null;
    eta_estimated_date: string | null;
  } | null;
};

type QueueLine = {
  id: string;
  product_id: string | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  approval_status: string | null;
  warehouse_status: string | null;
  queue_position_start: number | null;
  shipping_orders?: {
    id: string;
    legacy_customer_name: string | null;
    qbo_invoices?: {
      invoice_number: string | null;
      customers?: {
        company_name: string | null;
        full_name: string | null;
      } | null;
    } | null;
  } | null;
  inventory_allocations?: Array<{
    source_type: string | null;
    container_id: string | null;
    containers?: {
      container_number: string | null;
      lifecycle_status: string | null;
      eta_confirmed_date: string | null;
      eta_estimated_date: string | null;
    } | null;
  }>;
};

type InventoryViewRow = {
  productId: string;
  sku: string;
  productName: string;
  onFloor: number;
  soldOpenDemand: number;
  availableNow: number;
  incoming: number;
  nextEta: string;
  customerQueue: Array<{
    position: string;
    invoice: string;
    customer: string;
    qty: number;
    assignedTo: string;
    status: string;
    orderId: string;
  }>;
};

function formatNumber(value: number) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  if (Number.isInteger(rounded)) return new Intl.NumberFormat("en-US").format(rounded);
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rounded);
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function toRecordMap<T>(rows: T[], getKey: (row: T) => string | null, getValue: (row: T) => number) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = getKey(row);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + getValue(row));
  }
  return map;
}

function getAssignmentLabel(line: QueueLine) {
  const allocations = line.inventory_allocations ?? [];
  if (allocations.length === 0) return "Unassigned";

  return allocations.map((allocation) => {
    if (allocation.source_type === "FLOOR") {
      return "On Floor";
    }

    if (allocation.source_type === "CONTAINER") {
      const number = allocation.containers?.container_number ?? "Container";
      const status = formatStatus(allocation.containers?.lifecycle_status);
      const eta = formatShortDate(allocation.containers?.eta_confirmed_date ?? allocation.containers?.eta_estimated_date);
      return `${number} · ${status} · ETA ${eta}`;
    }

    return "Unassigned";
  }).join("; ");
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; mapError?: string; mapMessage?: string }>;
}) {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const params = await searchParams;
  const q = String(params.q ?? "").trim().toLowerCase();
  const mapError = String(params.mapError ?? "").trim();
  const mapMessage = String(params.mapMessage ?? "").trim();

  const [
    { data: products },
    { data: transactions },
    { data: containerLines },
    { data: queueLines },
  ] = await Promise.all([
    supabase.from("products").select("id, sku, canonical_name").order("sku", { ascending: true }),
    supabase.from("inventory_transactions").select("product_id, bucket, delta"),
    supabase
      .from("container_lines")
      .select("product_id, on_order_qty, container_id, containers (container_number, eta_confirmed_date, eta_estimated_date)"),
    supabase
      .from("shipping_order_lines")
      .select(`
        id,
        product_id,
        approved_qty,
        fulfilled_qty,
        approval_status,
        warehouse_status,
        queue_position_start,
        shipping_orders (
          id,
          legacy_customer_name,
          qbo_invoices (
            invoice_number,
            customers (company_name, full_name)
          )
        ),
        inventory_allocations (
          source_type,
          container_id,
          containers (container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date)
        )
      `)
      .in("approval_status", ["APPROVED", "PARTIAL"])
      .neq("fulfillment_status", "FULFILLED")
      .order("queue_position_start", { ascending: true, nullsFirst: false }),
  ]);

  const productRows = (products ?? []) as ProductRow[];
  const transactionRows = (transactions ?? []) as InventoryTransactionRow[];
  const containerLineRows = (containerLines ?? []) as ContainerLineRow[];
  const queueLineRows = (queueLines ?? []) as QueueLine[];

  const onFloorByProduct = toRecordMap(
    transactionRows.filter((row) => row.bucket === "ON_FLOOR"),
    (row) => row.product_id,
    (row) => Number(row.delta ?? 0),
  );

  const soldByProduct = toRecordMap(
    queueLineRows,
    (row) => row.product_id,
    (row) => Math.max(0, Number(row.approved_qty ?? 0) - Number(row.fulfilled_qty ?? 0)),
  );

  const incomingByProduct = toRecordMap(
    containerLineRows,
    (row) => row.product_id,
    (row) => Number(row.on_order_qty ?? 0),
  );

  const nextEtaByProduct = new Map<string, string>();
  const containerLabelByProduct = new Map<string, string>();

  for (const line of containerLineRows) {
    if (!line.product_id) continue;
    const eta = line.containers?.eta_confirmed_date ?? line.containers?.eta_estimated_date;
    const number = line.containers?.container_number;

    if (!number) continue;

    const etaLabel = formatShortDate(eta);
    const currentEta = nextEtaByProduct.get(line.product_id);

    if (!currentEta || etaLabel < currentEta) {
      nextEtaByProduct.set(line.product_id, etaLabel);
      containerLabelByProduct.set(line.product_id, `${number} · ${etaLabel}`);
    }
  }

  const queueByProduct = new Map<string, InventoryViewRow["customerQueue"]>();

  for (const line of queueLineRows) {
    if (!line.product_id) continue;

    const qty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
    if (qty <= 0) continue;

    const invoice = line.shipping_orders?.qbo_invoices?.invoice_number ?? "—";
    const customer = line.shipping_orders?.qbo_invoices?.customers?.company_name
      ?? line.shipping_orders?.qbo_invoices?.customers?.full_name
      ?? line.shipping_orders?.legacy_customer_name
      ?? "Customer pending";

    const row = {
      position: line.queue_position_start != null ? String(line.queue_position_start) : "—",
      invoice,
      customer,
      qty,
      assignedTo: getAssignmentLabel(line),
      status: formatStatus(line.warehouse_status ?? line.approval_status),
      orderId: line.shipping_orders?.id ?? "",
    };

    const arr = queueByProduct.get(line.product_id) ?? [];
    arr.push(row);
    queueByProduct.set(line.product_id, arr);
  }

  const rows: InventoryViewRow[] = productRows
    .map((product) => {
      const onFloor = onFloorByProduct.get(product.id) ?? 0;
      const soldOpenDemand = soldByProduct.get(product.id) ?? 0;
      const incoming = incomingByProduct.get(product.id) ?? 0;
      const availableNow = onFloor - soldOpenDemand;

      return {
        productId: product.id,
        sku: product.sku ?? "—",
        productName: product.canonical_name ?? "Unnamed Product",
        onFloor,
        soldOpenDemand,
        availableNow,
        incoming,
        nextEta: containerLabelByProduct.get(product.id) ?? "—",
        customerQueue: queueByProduct.get(product.id) ?? [],
      };
    })
    .filter((row) => {
      if (!q) return true;
      const searchable = `${row.sku} ${row.productName}`.toLowerCase();
      return searchable.includes(q);
    });

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#6b7280]">Inventory</p>
            <h1 className="mt-1 text-3xl font-semibold text-[#111827]">Lift Availability</h1>
            <p className="mt-2 text-sm text-[#5a5a5a]">Search product availability, incoming containers/ETA, and approved customer queue by SKU.</p>
          </div>
          <AddProductModal createAction={createProductAction} />
        </div>
      </div>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <form className="space-y-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Product lookup</p>
            <label htmlFor="inventory-search" className="mt-1 block text-sm font-semibold text-[#334155]">Find an item by name or SKU</label>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              id="inventory-search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Search item name or SKU..."
              className="input min-w-[260px] flex-1 text-base"
            />
            <button className="btn-primary" type="submit">Lookup</button>
            <Link className="btn-ghost" href="/inventory">Clear</Link>
          </div>
        </form>
      </section>

      {mapError ? <p className="rounded-md border border-[#fecaca] bg-[#fff1f2] p-3 text-sm text-[#991b1b]">{mapError}</p> : null}
      {mapMessage ? <p className="rounded-md border border-[#bbf7d0] bg-[#f0fdf4] p-3 text-sm text-[#166534]">{mapMessage}</p> : null}

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#eceff3] text-xs uppercase tracking-[0.08em] text-[#64748b]">
                <th className="w-[280px] max-w-[280px] px-2 py-2">Item</th>
                <th className="px-2 py-2">On Floor</th>
                <th className="px-2 py-2">Sold / Open Demand</th>
                <th className="px-2 py-2">Available Now</th>
                <th className="px-2 py-2">Incoming</th>
                <th className="px-2 py-2">Next ETA</th>
                <th className="px-2 py-2">Customer List</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-2 py-10 text-center text-[#6b7280]">No products match this search.</td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.productId} className="border-b border-[#f1f5f9] align-top">
                    <td className="w-[280px] max-w-[280px] px-2 py-3">
                      <div className="line-clamp-2 max-w-[260px] break-words font-semibold leading-5 text-[#111827]" title={row.productName}>{row.productName}</div>
                      <div className="mt-1 text-xs font-medium text-[#64748b]">SKU {row.sku}</div>
                    </td>
                    <td className="px-2 py-3">{formatNumber(row.onFloor)}</td>
                    <td className="px-2 py-3">{formatNumber(row.soldOpenDemand)}</td>
                    <td className={`px-2 py-3 font-semibold ${row.availableNow < 0 ? "text-[#dc2626]" : "text-[#111827]"}`}>
                      {formatNumber(row.availableNow)}
                    </td>
                    <td className="px-2 py-3">{formatNumber(row.incoming)}</td>
                    <td className="px-2 py-3">{row.nextEta}</td>
                    <td className="px-2 py-3">
                      <CustomerDemandDropdown
                        productName={row.productName}
                        sku={row.sku}
                        openQuantity={formatNumber(row.soldOpenDemand)}
                        customerQueue={row.customerQueue}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
