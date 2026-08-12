import Link from "next/link";
import fs from "node:fs";
import path from "node:path";
import { createProductAliasAction, seedProductCatalogAction } from "@/app/(protected)/inventory/actions";
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

function normalizeSku(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function readLatestBacklogUnmappedSkus() {
  const reportPath = path.join(process.cwd(), "tmp", "import-reports", "backlog-import-preview-latest.json");
  if (!fs.existsSync(reportPath)) {
    return [] as string[];
  }

  try {
    const raw = fs.readFileSync(reportPath, "utf8");
    const parsed = JSON.parse(raw) as {
      preview?: {
        unmappedSkus?: unknown;
      };
    };

    const list = parsed.preview?.unmappedSkus;
    if (!Array.isArray(list)) {
      return [] as string[];
    }

    return list
      .map((value) => normalizeSku(typeof value === "string" ? value : null))
      .filter((value) => value.length > 0);
  } catch {
    return [] as string[];
  }
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

  const backlogUnmappedFromReport = readLatestBacklogUnmappedSkus();
  const backlogUnmappedSkus = Array.from(new Set(backlogUnmappedFromReport)).sort((a, b) => a.localeCompare(b));

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
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#6b7280]">Inventory</p>
        <h1 className="mt-1 text-3xl font-semibold text-[#111827]">Lift Availability</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">Search product availability, incoming containers/ETA, and approved customer queue by SKU.</p>
      </div>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <form className="space-y-3">
          <label htmlFor="inventory-search" className="text-sm font-semibold text-[#334155]">Search SKU / Product</label>
          <div className="flex flex-wrap gap-2">
            <input
              id="inventory-search"
              name="q"
              defaultValue={params.q ?? ""}
              placeholder="Type SKU or product name..."
              className="input min-w-[260px] flex-1 text-base"
            />
            <button className="btn-secondary" type="submit">Search</button>
            <Link className="btn-ghost" href="/inventory">Clear</Link>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">SKU Mapping</p>
            <h2 className="mt-1 text-xl font-semibold text-[#0f172a]">Map Unmapped SKUs</h2>
            <p className="mt-1 text-sm text-[#5a5a5a]">
              Add product aliases from this page. All current products are available below as canonical targets.
            </p>
          </div>
          <p className="rounded-md border border-[#dbeafe] bg-[#eff6ff] px-2 py-1 text-xs font-semibold text-[#1d4ed8]">
            Current products: {productRows.length}
          </p>
        </div>

        {mapError ? (
          <p className="mt-3 rounded-md border border-[#fecaca] bg-[#fff1f2] p-2 text-sm text-[#991b1b]">{mapError}</p>
        ) : null}

        {mapMessage ? (
          <p className="mt-3 rounded-md border border-[#bbf7d0] bg-[#f0fdf4] p-2 text-sm text-[#166534]">{mapMessage}</p>
        ) : null}

        <div className="mt-3">
          <p className="text-sm font-semibold text-[#334155]">Unmapped backlog SKUs</p>
          {backlogUnmappedSkus.length === 0 ? (
            <p className="mt-1 text-sm text-[#64748b]">None detected from latest backlog preview report.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {backlogUnmappedSkus.map((sku) => (
                <span key={sku} className="rounded-md border border-[#fed7aa] bg-[#fff7ed] px-2 py-1 text-xs font-semibold text-[#9a3412]">
                  {sku}
                </span>
              ))}
            </div>
          )}
        </div>

        <form action={createProductAliasAction} className="mt-4 grid gap-3 md:grid-cols-[minmax(220px,1fr)_minmax(260px,1.5fr)_auto]">
          <div>
            <label htmlFor="alias_sku" className="text-sm font-semibold text-[#334155]">Alias SKU (unmapped)</label>
            <input
              id="alias_sku"
              name="alias_sku"
              list="inventory-unmapped-skus"
              className="input mt-1"
              placeholder="e.g. 4PHR-9"
              required
            />
            <datalist id="inventory-unmapped-skus">
              {backlogUnmappedSkus.map((sku) => (
                <option key={sku} value={sku} />
              ))}
            </datalist>
          </div>

          <div>
            <label htmlFor="product_id" className="text-sm font-semibold text-[#334155]">Canonical Product (all current products)</label>
            <select id="product_id" name="product_id" className="input mt-1" required defaultValue="">
              <option value="" disabled>Select product...</option>
              {productRows.map((product) => {
                const sku = product.sku ?? "(missing sku)";
                const name = product.canonical_name ?? "Unnamed Product";
                return (
                  <option key={product.id} value={product.id}>{sku} - {name}</option>
                );
              })}
            </select>
          </div>

          <div className="flex items-end">
            <button type="submit" className="btn-primary w-full md:w-auto">Save Alias</button>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Catalog Seed</p>
          <h2 className="mt-1 text-xl font-semibold text-[#0f172a]">Bulk Add Products From CSV</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">
            Paste rows in the same format as the backlog worklist to create missing products and aliases inside the app.
          </p>
        </div>

        <form action={seedProductCatalogAction} className="mt-3 space-y-3">
          <label htmlFor="catalog_csv" className="text-sm font-semibold text-[#334155]">CSV rows</label>
          <textarea
            id="catalog_csv"
            name="catalog_csv"
            className="input min-h-[180px] w-full font-mono text-xs leading-5"
            placeholder="sku,total_qty,line_count,containers,description_sample,canonical_product_sku,notes"
            required
          />
          <p className="text-xs text-[#64748b]">
            Required column: <span className="font-semibold">sku</span>. Optional columns: <span className="font-semibold">canonical_product_sku</span>, <span className="font-semibold">canonical_name</span>, <span className="font-semibold">description_sample</span>, <span className="font-semibold">notes</span>.
          </p>
          <button type="submit" className="btn-primary">Seed Catalog</button>
        </form>
      </section>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#eceff3] text-xs uppercase tracking-[0.08em] text-[#64748b]">
                <th className="px-2 py-2">SKU</th>
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
                    <td className="px-2 py-3">
                      <div className="font-semibold text-[#1d4ed8]">{row.sku}</div>
                      <div className="text-xs text-[#64748b]">{row.productName}</div>
                    </td>
                    <td className="px-2 py-3">{formatNumber(row.onFloor)}</td>
                    <td className="px-2 py-3">{formatNumber(row.soldOpenDemand)}</td>
                    <td className={`px-2 py-3 font-semibold ${row.availableNow < 0 ? "text-[#dc2626]" : "text-[#111827]"}`}>
                      {formatNumber(row.availableNow)}
                    </td>
                    <td className="px-2 py-3">{formatNumber(row.incoming)}</td>
                    <td className="px-2 py-3">{row.nextEta}</td>
                    <td className="px-2 py-3">
                      <details>
                        <summary className="cursor-pointer text-sm font-semibold text-[#2563eb] hover:underline">
                          Customer List ({row.customerQueue.length})
                        </summary>
                        <div className="mt-2 max-w-full overflow-x-auto rounded-lg border border-[#e5e7eb] bg-[#f8fafc] p-2">
                          {row.customerQueue.length === 0 ? (
                            <p className="px-2 py-2 text-xs text-[#64748b]">No approved open queue for this SKU.</p>
                          ) : (
                            <table className="w-full min-w-[760px] text-xs">
                              <thead>
                                <tr className="border-b border-[#d8dee8] text-[#64748b]">
                                  <th className="px-2 py-1 text-left">Position</th>
                                  <th className="px-2 py-1 text-left">Invoice</th>
                                  <th className="px-2 py-1 text-left">Customer</th>
                                  <th className="px-2 py-1 text-left">Qty</th>
                                  <th className="px-2 py-1 text-left">Assigned To</th>
                                  <th className="px-2 py-1 text-left">Status</th>
                                  <th className="px-2 py-1 text-left">Open</th>
                                </tr>
                              </thead>
                              <tbody>
                                {row.customerQueue.map((item, idx) => (
                                  <tr key={`${item.orderId}-${item.invoice}-${idx}`} className="border-b border-[#edf2f7]">
                                    <td className="px-2 py-1">{item.position}</td>
                                    <td className="px-2 py-1">{item.invoice}</td>
                                    <td className="px-2 py-1">{item.customer}</td>
                                    <td className="px-2 py-1">{formatNumber(item.qty)}</td>
                                    <td className="px-2 py-1">{item.assignedTo}</td>
                                    <td className="px-2 py-1">{item.status}</td>
                                    <td className="px-2 py-1">
                                      {item.orderId ? (
                                        <Link href={`/orders/${item.orderId}`} className="text-[#2563eb] hover:underline">Invoice</Link>
                                      ) : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </details>
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
