import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

type ProductRow = {
  id: string;
  sku: string | null;
  canonical_name: string | null;
  status: string | null;
};

type InventoryTransactionRow = {
  product_id: string | null;
  bucket: string | null;
  delta: number | null;
};

type ContainerRow = {
  id: string;
  container_number: string | null;
  supplier: string | null;
  lifecycle_status: string | null;
  eta_confirmed_date: string | null;
  eta_estimated_date: string | null;
  entered_date: string | null;
};

type ContainerLineRow = {
  container_id: string | null;
  product_id: string | null;
  ordered_qty: number | null;
  received_qty: number | null;
  on_order_qty: number | null;
};

type ShippingOrderLineRow = {
  shipping_order_id: string | null;
  product_id: string | null;
  ordered_qty: number | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  warehouse_status: string | null;
  fulfillment_status: string | null;
  approval_status: string | null;
};

type ShippingOrderRow = {
  id: string;
  review_status: string | null;
  qbo_invoices?: {
    invoice_number: string | null;
  } | null;
};

type InventoryRecord = {
  id: string;
  sku: string;
  name: string;
  status: string;
  onFloor: number;
  soldOpenDemand: number;
  availableNow: number;
  incoming: number;
  incomingContainers: string[];
  orderCount: number;
};

function formatNumber(value: number) {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  if (Number.isInteger(rounded)) {
    return new Intl.NumberFormat("en-US").format(rounded);
  }
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(rounded);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getEtaDate(container: ContainerRow) {
  if (container.eta_confirmed_date) {
    const confirmed = new Date(container.eta_confirmed_date);
    if (!Number.isNaN(confirmed.getTime())) return confirmed;
  }

  if (container.eta_estimated_date) {
    const estimated = new Date(container.eta_estimated_date);
    if (!Number.isNaN(estimated.getTime())) return estimated;
  }

  if (container.entered_date) {
    const entered = new Date(container.entered_date);
    if (!Number.isNaN(entered.getTime())) {
      entered.setDate(entered.getDate() + 75);
      return entered;
    }
  }

  return null;
}

function getInventoryState(availableNow: number) {
  if (availableNow <= 0) {
    return { label: "Out of Stock", className: "bg-[#fee2e2] text-[#b91c1c]" };
  }
  if (availableNow <= 5) {
    return { label: "Low Stock", className: "bg-[#fef3c7] text-[#92400e]" };
  }
  return { label: "In Stock", className: "bg-[#dcfce7] text-[#166534]" };
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

export default async function InventoryOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; lowStock?: string }>;
}) {
  const supabase = await createClient();
  const params = await searchParams;
  const query = (params.q ?? "").trim().toLowerCase();
  const statusFilter = params.status ?? "all";
  const lowStockOnly = params.lowStock === "1";

  const [
    { data: products },
    { data: transactions },
    { data: containers },
    { data: containerLines },
    { data: shippingOrderLines },
    { data: shippingOrders },
  ] = await Promise.all([
    supabase.from("products").select("id, sku, canonical_name, status").order("canonical_name", { ascending: true }),
    supabase.from("inventory_transactions").select("product_id, bucket, delta"),
    supabase
      .from("containers")
      .select("id, container_number, supplier, lifecycle_status, eta_confirmed_date, eta_estimated_date, entered_date")
      .order("created_at", { ascending: false })
      .limit(120),
    supabase.from("container_lines").select("container_id, product_id, ordered_qty, received_qty, on_order_qty"),
    supabase
      .from("shipping_order_lines")
      .select("shipping_order_id, product_id, ordered_qty, approved_qty, fulfilled_qty, warehouse_status, fulfillment_status, approval_status"),
    supabase
      .from("shipping_orders")
      .select("id, review_status, qbo_invoices(invoice_number)")
      .limit(220),
  ]);

  const productRows = (products ?? []) as ProductRow[];
  const transactionRows = (transactions ?? []) as InventoryTransactionRow[];
  const containerRows = (containers ?? []) as ContainerRow[];
  const containerLineRows = (containerLines ?? []) as ContainerLineRow[];
  const shippingLineRows = (shippingOrderLines ?? []) as ShippingOrderLineRow[];
  const shippingOrderRows = (shippingOrders ?? []) as ShippingOrderRow[];

  const onFloorByProduct = toRecordMap(
    transactionRows.filter((row) => row.bucket === "ON_FLOOR"),
    (row) => row.product_id,
    (row) => Number(row.delta ?? 0),
  );

  const incomingAvailableByProduct = toRecordMap(
    transactionRows.filter((row) => row.bucket === "INCOMING_AVAILABLE"),
    (row) => row.product_id,
    (row) => Number(row.delta ?? 0),
  );

  const incomingByProduct = toRecordMap(
    containerLineRows,
    (row) => row.product_id,
    (row) => Number(row.on_order_qty ?? 0),
  );

  const demandByProduct = toRecordMap(
    shippingLineRows,
    (row) => row.product_id,
    (row) => Math.max(0, Number(row.approved_qty ?? row.ordered_qty ?? 0) - Number(row.fulfilled_qty ?? 0)),
  );

  const orderCountByProduct = new Map<string, Set<string>>();
  for (const row of shippingLineRows) {
    if (!row.product_id || !row.shipping_order_id) continue;
    const set = orderCountByProduct.get(row.product_id) ?? new Set<string>();
    set.add(row.shipping_order_id);
    orderCountByProduct.set(row.product_id, set);
  }

  const containerSkuByProduct = new Map<string, Set<string>>();
  for (const line of containerLineRows) {
    if (!line.product_id || !line.container_id) continue;
    const container = containerRows.find((entry) => entry.id === line.container_id);
    if (!container?.container_number) continue;
    const set = containerSkuByProduct.get(line.product_id) ?? new Set<string>();
    set.add(container.container_number);
    containerSkuByProduct.set(line.product_id, set);
  }

  const inventoryRows: InventoryRecord[] = productRows.map((product) => {
    const onFloor = onFloorByProduct.get(product.id) ?? 0;
    const incomingAvailable = incomingAvailableByProduct.get(product.id) ?? 0;
    const availableNow = onFloor + incomingAvailable;
    const incoming = incomingByProduct.get(product.id) ?? 0;
    const soldOpenDemand = demandByProduct.get(product.id) ?? 0;
    const incomingContainers = Array.from(containerSkuByProduct.get(product.id) ?? []);
    const orderCount = (orderCountByProduct.get(product.id) ?? new Set<string>()).size;

    return {
      id: product.id,
      sku: product.sku ?? "—",
      name: product.canonical_name ?? "Unnamed Product",
      status: product.status ?? "Active",
      onFloor,
      soldOpenDemand,
      availableNow,
      incoming,
      incomingContainers,
      orderCount,
    };
  });

  const filteredRows = inventoryRows.filter((row) => {
    if (query) {
      const searchable = `${row.sku} ${row.name}`.toLowerCase();
      if (!searchable.includes(query)) return false;
    }

    const stockState = getInventoryState(row.availableNow);
    if (statusFilter === "in-stock" && stockState.label !== "In Stock") return false;
    if (statusFilter === "low" && stockState.label !== "Low Stock") return false;
    if (statusFilter === "out" && stockState.label !== "Out of Stock") return false;
    if (lowStockOnly && stockState.label === "In Stock") return false;

    return true;
  });

  const availableInventory = inventoryRows.reduce((sum, row) => sum + row.availableNow, 0);
  const soldOpenDemand = inventoryRows.reduce((sum, row) => sum + row.soldOpenDemand, 0);
  const incomingInventory = inventoryRows.reduce((sum, row) => sum + row.incoming, 0);
  const lowStockCount = inventoryRows.filter((row) => row.availableNow <= 5).length;
  const outOfStockCount = inventoryRows.filter((row) => row.availableNow <= 0).length;

  const activeContainers = containerRows.filter((container) => {
    const status = container.lifecycle_status ?? "";
    return status === "ORDERED" || status === "PRODUCTION" || status === "INBOUND";
  });

  const inventoryAlerts = [
    {
      id: "low-stock",
      title: `${formatNumber(lowStockCount)} SKUs are low or out of stock`,
      href: "/inventory?lowStock=1",
      action: "View Low Stock Report",
    },
    {
      id: "orders-waiting",
      title: `${formatNumber(shippingLineRows.filter((row) => row.approval_status === "PENDING_REVIEW").length)} orders waiting for inventory`,
      href: "/orders?tab=new",
      action: "View Orders",
    },
    {
      id: "next-container",
      title: (() => {
        const next = activeContainers
          .map((container) => ({ container, eta: getEtaDate(container) }))
          .filter((entry): entry is { container: ContainerRow; eta: Date } => Boolean(entry.eta))
          .sort((a, b) => a.eta.getTime() - b.eta.getTime())[0];

        if (!next) return "No active inbound container ETA";
        return `${next.container.container_number ?? "Container"} arriving ${formatDate(next.eta.toISOString())}`;
      })(),
      href: "/containers",
      action: "View Containers",
    },
  ];

  const quickActions = [
    { label: "Add Container", href: "/containers#add-container" },
    { label: "View New Orders", href: "/orders?tab=new" },
    { label: "Low Stock Report", href: "/inventory?lowStock=1" },
    { label: "Inventory Adjustments", href: "/adjustments" },
    { label: "Print Inventory Summary", href: "/inventory" },
  ];

  const containerSummaryRows = activeContainers.map((container) => {
    const lines = containerLineRows.filter((line) => line.container_id === container.id);
    const totalUnits = lines.reduce((sum, line) => sum + Number(line.ordered_qty ?? 0), 0);
    const receivedUnits = lines.reduce((sum, line) => sum + Number(line.received_qty ?? 0), 0);
    const percentReceived = totalUnits > 0 ? Math.round((receivedUnits / totalUnits) * 100) : 0;

    return {
      id: container.id,
      containerNumber: container.container_number ?? "Container",
      supplier: container.supplier ?? "Supplier pending",
      status: container.lifecycle_status ?? "ORDERED",
      etaConfirmed: formatDate(container.eta_confirmed_date),
      etaEstimated: formatDate(container.eta_estimated_date),
      totalUnits,
      percentReceived,
    };
  }).slice(0, 6);

  const lowStockRows = [...inventoryRows]
    .filter((row) => row.availableNow <= 5)
    .sort((a, b) => a.availableNow - b.availableNow)
    .slice(0, 5)
    .map((row) => ({
      sku: row.sku,
      available: row.availableNow,
      incoming: row.incoming,
      short: Math.max(0, 5 - row.availableNow),
    }));

  const orderById = new Map<string, ShippingOrderRow>();
  for (const order of shippingOrderRows) {
    orderById.set(order.id, order);
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#6b7280]">Inventory Overview</p>
            <h1 className="mt-1 text-3xl font-semibold text-[#111827]">Inventory</h1>
          </div>
          <div className="flex gap-2">
            <Link href="/products" className="btn-secondary">Manage Products</Link>
            <Link href="/orders" className="btn-secondary">Open Orders</Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-5">
            <article className="rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">On Floor</p>
              <p className="mt-2 text-3xl font-semibold text-[#111827]">{formatNumber(inventoryRows.reduce((sum, row) => sum + row.onFloor, 0))}</p>
              <p className="mt-1 text-xs text-[#16a34a]">Live stock</p>
            </article>
            <article className="rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Sold / Open Demand</p>
              <p className="mt-2 text-3xl font-semibold text-[#111827]">{formatNumber(soldOpenDemand)}</p>
              <p className="mt-1 text-xs text-[#16a34a]">Based on approved lines</p>
            </article>
            <article className="rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Available Now</p>
              <p className="mt-2 text-3xl font-semibold text-[#059669]">{formatNumber(availableInventory)}</p>
              <p className="mt-1 text-xs text-[#16a34a]">Current sellable units</p>
            </article>
            <article className="rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Incoming</p>
              <p className="mt-2 text-3xl font-semibold text-[#7c3aed]">{formatNumber(incomingInventory)}</p>
              <p className="mt-1 text-xs text-[#64748b]">On {formatNumber(activeContainers.length)} containers</p>
            </article>
            <article className="rounded-xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Low / Out of Stock</p>
              <p className="mt-2 text-3xl font-semibold text-[#dc2626]">{formatNumber(lowStockCount)}</p>
              <Link href="/inventory?lowStock=1" className="mt-1 inline-flex text-xs font-semibold text-[#dc2626] hover:underline">View details</Link>
            </article>
          </div>

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
            <form className="grid gap-2 md:grid-cols-[1.4fr_1fr_1fr_auto_auto]">
              <input name="q" defaultValue={params.q ?? ""} placeholder="Search by SKU or product name..." className="input" />
              <select name="status" defaultValue={statusFilter} className="select">
                <option value="all">All Statuses</option>
                <option value="in-stock">In Stock</option>
                <option value="low">Low Stock</option>
                <option value="out">Out of Stock</option>
              </select>
              <label className="inline-flex items-center gap-2 rounded-lg border border-[#e5e7eb] px-3 py-2 text-sm text-[#334155]">
                <input type="checkbox" name="lowStock" value="1" defaultChecked={lowStockOnly} />
                Low / Out of Stock
              </label>
              <button type="submit" className="btn-secondary">Apply</button>
              <Link href="/inventory" className="btn-ghost">Clear</Link>
            </form>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[#eceff3] text-xs uppercase tracking-[0.07em] text-[#64748b]">
                    <th className="px-2 py-2">SKU</th>
                    <th className="px-2 py-2">Product</th>
                    <th className="px-2 py-2">On Floor</th>
                    <th className="px-2 py-2">Sold / Demand</th>
                    <th className="px-2 py-2">Available</th>
                    <th className="px-2 py-2">Incoming</th>
                    <th className="px-2 py-2">Incoming Containers (ETA)</th>
                    <th className="px-2 py-2">Status</th>
                    <th className="px-2 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-2 py-8 text-center text-[#6b7280]">No products match your filters.</td>
                    </tr>
                  ) : (
                    filteredRows.map((row) => {
                      const stockState = getInventoryState(row.availableNow);
                      const firstContainer = row.incomingContainers[0] ?? "—";
                      return (
                        <tr key={row.id} className="border-b border-[#f1f5f9] hover:bg-[#f8fafc]">
                          <td className="px-2 py-2 font-semibold text-[#1d4ed8]">{row.sku}</td>
                          <td className="px-2 py-2">{row.name}</td>
                          <td className="px-2 py-2">{formatNumber(row.onFloor)}</td>
                          <td className="px-2 py-2">{formatNumber(row.soldOpenDemand)}</td>
                          <td className={`px-2 py-2 font-semibold ${row.availableNow <= 0 ? "text-[#dc2626]" : "text-[#111827]"}`}>{formatNumber(row.availableNow)}</td>
                          <td className="px-2 py-2 text-[#1d4ed8]">{formatNumber(row.incoming)}</td>
                          <td className="px-2 py-2 text-xs text-[#475569]">
                            <div>{firstContainer}</div>
                            <div className="text-[#94a3b8]">{row.incomingContainers.length > 1 ? `+${row.incomingContainers.length - 1} more` : ""}</div>
                          </td>
                          <td className="px-2 py-2">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${stockState.className}`}>
                              {stockState.label}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-right">
                            <Link href={`/shipping-review?productId=${row.id}`} className="text-xs font-semibold text-[#2563eb] hover:underline">Show Orders</Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {filteredRows.length > 0 ? (
              <div className="mt-4 rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-semibold text-[#111827]">Orders waiting (sample)</h3>
                  <Link href="/orders?tab=accepted" className="text-xs font-semibold text-[#2563eb] hover:underline">View All Orders</Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-xs">
                    <thead>
                      <tr className="border-b border-[#e2e8f0] text-[#64748b]">
                        <th className="px-2 py-2">Invoice #</th>
                        <th className="px-2 py-2">Ordered</th>
                        <th className="px-2 py-2">Approved</th>
                        <th className="px-2 py-2">Remaining</th>
                        <th className="px-2 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shippingLineRows.slice(0, 6).map((line, index) => {
                        const order = line.shipping_order_id ? orderById.get(line.shipping_order_id) : null;
                        const remaining = Math.max(0, Number(line.approved_qty ?? line.ordered_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
                        return (
                          <tr key={`${line.shipping_order_id ?? "order"}-${index}`} className="border-b border-[#f1f5f9]">
                            <td className="px-2 py-2 text-[#1d4ed8]">{order?.qbo_invoices?.invoice_number ?? "—"}</td>
                            <td className="px-2 py-2">{formatNumber(Number(line.ordered_qty ?? 0))}</td>
                            <td className="px-2 py-2">{formatNumber(Number(line.approved_qty ?? 0))}</td>
                            <td className="px-2 py-2">{formatNumber(remaining)}</td>
                            <td className="px-2 py-2">{line.warehouse_status ?? "PENDING_REVIEW"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </section>

          <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
            <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#111827]">Incoming Containers Summary</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-[#eceff3] text-[#64748b]">
                      <th className="px-2 py-2">Container #</th>
                      <th className="px-2 py-2">Supplier</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2">ETA (Confirmed)</th>
                      <th className="px-2 py-2">ETA (Estimated)</th>
                      <th className="px-2 py-2">Total Units</th>
                      <th className="px-2 py-2">% Received</th>
                      <th className="px-2 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {containerSummaryRows.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-2 py-6 text-center text-[#6b7280]">No active containers.</td>
                      </tr>
                    ) : (
                      containerSummaryRows.map((row) => (
                        <tr key={row.id} className="border-b border-[#f1f5f9]">
                          <td className="px-2 py-2 font-semibold text-[#1d4ed8]">{row.containerNumber}</td>
                          <td className="px-2 py-2">{row.supplier}</td>
                          <td className="px-2 py-2">{row.status}</td>
                          <td className="px-2 py-2">{row.etaConfirmed}</td>
                          <td className="px-2 py-2">{row.etaEstimated}</td>
                          <td className="px-2 py-2">{formatNumber(row.totalUnits)}</td>
                          <td className="px-2 py-2">{row.percentReceived}%</td>
                          <td className="px-2 py-2"><Link href={`/containers/${row.id}`} className="text-[#2563eb] hover:underline">View</Link></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#111827]">Low Stock SKUs (Top 5)</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[280px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-[#eceff3] text-[#64748b]">
                      <th className="px-2 py-2">SKU</th>
                      <th className="px-2 py-2">Available</th>
                      <th className="px-2 py-2">Incoming</th>
                      <th className="px-2 py-2">Short</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowStockRows.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-2 py-6 text-center text-[#6b7280]">No low stock SKUs.</td>
                      </tr>
                    ) : (
                      lowStockRows.map((row) => (
                        <tr key={row.sku} className="border-b border-[#f1f5f9]">
                          <td className="px-2 py-2 font-semibold text-[#1d4ed8]">{row.sku}</td>
                          <td className="px-2 py-2 text-[#dc2626]">{formatNumber(row.available)}</td>
                          <td className="px-2 py-2">{formatNumber(row.incoming)}</td>
                          <td className="px-2 py-2 text-[#dc2626]">{formatNumber(row.short)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <Link href="/inventory?lowStock=1" className="mt-3 inline-flex text-sm font-semibold text-[#2563eb] hover:underline">View Full Low Stock Report</Link>
            </section>
          </div>
        </div>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#111827]">Inventory Alerts</h2>
            <div className="mt-3 space-y-2">
              {inventoryAlerts.map((alert) => (
                <div key={alert.id} className="rounded-xl border border-[#e5e7eb] bg-[#f9fafb] p-3">
                  <p className="text-sm font-medium text-[#111827]">{alert.title}</p>
                  <Link href={alert.href} className="mt-1 inline-flex text-xs font-semibold text-[#2563eb] hover:underline">{alert.action}</Link>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#111827]">Quick Actions</h2>
            <div className="mt-3 space-y-2">
              {quickActions.map((action) => (
                <Link key={action.label} href={action.href} className="block rounded-xl border border-[#e5e7eb] bg-[#f9fafb] px-3 py-2 text-sm font-medium text-[#1f2937] hover:bg-[#eef2f7]">
                  {action.label}
                </Link>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <div className="hidden" aria-hidden="true">
        {outOfStockCount}
      </div>
    </div>
  );
}
