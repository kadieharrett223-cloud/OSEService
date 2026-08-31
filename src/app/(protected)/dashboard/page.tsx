import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type ProductRow = {
  id: string;
  sku: string | null;
  canonical_name: string | null;
};

function isOperationalInventoryProduct(product: ProductRow) {
  return product.sku?.trim().toUpperCase() !== "TEST";
}

async function loadAllInventoryTransactions() {
  const supabase = getSupabaseAdmin();
  const rows: InventoryTransactionRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("inventory_transactions").select("product_id, bucket, delta, created_at").range(from, from + 999);
    if (error) throw error;
    rows.push(...((data ?? []) as InventoryTransactionRow[]));
    if ((data ?? []).length < 1000) return rows;
  }
}

type InventoryTransactionRow = {
  product_id: string | null;
  bucket: string | null;
  delta: number | null;
  created_at: string;
};

type ContainerRow = {
  id: string;
  container_number: string | null;
  lifecycle_status: string | null;
  created_at: string;
  updated_at: string;
  entered_date: string | null;
  eta_confirmed_date: string | null;
  eta_estimated_date: string | null;
};

type ContainerLineRow = {
  container_id: string | null;
  on_order_qty: number | null;
};

type OrderRow = {
  id: string;
  review_status: string | null;
  qbo_invoices?: {
    payment_status: string | null;
    invoice_date: string | null;
    raw_payload?: { PrivateNote?: string | null } | null;
  } | null;
  shipping_order_lines?: Array<{
    approval_status: string | null;
    warehouse_status: string | null;
    fulfillment_status: string | null;
  }>;
};

type CaseRow = {
  id: string;
  case_number: string;
  status: string;
  priority: string;
  updated_at: string;
};

type InstallationRow = {
  id: string;
  status: string;
};

type AuditRow = {
  id: string;
  entity_type: string;
  entity_id: string | null;
  action: string;
  created_at: string;
};

type ActivityItem = {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  createdAt: string;
};

function formatRelative(dateIso: string) {
  const deltaMs = Date.now() - new Date(dateIso).getTime();
  const hours = Math.floor(deltaMs / (1000 * 60 * 60));
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function isResolvedCase(status: string) {
  return status === "Resolved" || status === "Completed" || status === "Closed";
}

function needsInstallationAttention(status: string) {
  const normalized = status.toLowerCase();
  return !(normalized.includes("complete") || normalized.includes("closed") || normalized.includes("done") || normalized.includes("installed"));
}

function getContainerEtaDate(container: ContainerRow) {
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

export default async function DashboardPage() {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const [
    { data: products },
    { data: inventoryTransactions },
    allInventoryTransactions,
    { data: containers },
    { data: containerLines },
    { data: orders },
    { data: cases },
    { data: installations },
    { data: audits },
  ] = await Promise.all([
    supabase.from("products").select("id, sku, canonical_name"),
    supabase.from("inventory_transactions").select("product_id, bucket, delta, created_at").order("created_at", { ascending: false }).limit(120),
    loadAllInventoryTransactions(),
    supabase
      .from("containers")
      .select("id, container_number, lifecycle_status, created_at, updated_at, entered_date, eta_confirmed_date, eta_estimated_date")
      .order("updated_at", { ascending: false })
      .limit(120),
    supabase.from("container_lines").select("container_id, on_order_qty"),
    supabase
      .from("shipping_orders")
      .select(`
        id,
        review_status,
        qbo_invoices (payment_status, invoice_date, raw_payload),
        shipping_order_lines (approval_status, warehouse_status, fulfillment_status)
      `)
      .order("created_at", { ascending: false })
      .limit(220),
    supabase.from("customer_service_cases").select("id, case_number, status, priority, updated_at").order("updated_at", { ascending: false }).limit(120),
    supabase.from("installation_jobs").select("id, status").order("updated_at", { ascending: false }).limit(120),
    supabase.from("audit_log").select("id, entity_type, entity_id, action, created_at").order("created_at", { ascending: false }).limit(120),
  ]);

  const productRows = ((products ?? []) as ProductRow[]).filter(isOperationalInventoryProduct);
  const operationalProductIds = new Set(productRows.map((product) => product.id));
  const transactionRows = (inventoryTransactions ?? []) as InventoryTransactionRow[];
  const containerRows = (containers ?? []) as ContainerRow[];
  const containerLineRows = (containerLines ?? []) as ContainerLineRow[];
  const orderRows = ((orders ?? []) as unknown as OrderRow[]).filter((order) => String(order.qbo_invoices?.raw_payload?.PrivateNote ?? "").trim().toUpperCase() !== "VOIDED");
  const caseRows = (cases ?? []) as CaseRow[];
  const installationRows = (installations ?? []) as InstallationRow[];
  const auditRows = (audits ?? []) as AuditRow[];

  const inventoryByProduct = new Map<string, { onFloor: number; incomingAvailable: number }>();
  for (const row of allInventoryTransactions) {
    if (!row.product_id || !operationalProductIds.has(row.product_id)) continue;
    const current = inventoryByProduct.get(row.product_id) ?? { onFloor: 0, incomingAvailable: 0 };
    const delta = Number(row.delta ?? 0);
    if (row.bucket === "ON_FLOOR") current.onFloor += delta;
    if (row.bucket === "INCOMING_AVAILABLE") current.incomingAvailable += delta;
    inventoryByProduct.set(row.product_id, current);
  }

  const availableInventory = Array.from(inventoryByProduct.values()).reduce((sum, row) => sum + row.onFloor + row.incomingAvailable, 0);
  const onFloorInventory = Array.from(inventoryByProduct.values()).reduce((sum, row) => sum + row.onFloor, 0);

  const lowOutOfStock = productRows.filter((product) => {
    const metrics = inventoryByProduct.get(product.id) ?? { onFloor: 0, incomingAvailable: 0 };
    return metrics.onFloor + metrics.incomingAvailable <= 5;
  }).length;

  const activeContainerIds = new Set(
    containerRows
      .filter((container) => {
        const status = container.lifecycle_status ?? "";
        return status === "ORDERED" || status === "PRODUCTION" || status === "INBOUND";
      })
      .map((container) => container.id),
  );

  const incomingInventory = containerLineRows.reduce((sum, line) => {
    if (!line.container_id || !activeContainerIds.has(line.container_id)) return sum;
    return sum + Number(line.on_order_qty ?? 0);
  }, 0);

  const newOrders = orderRows.filter((order) => {
    const lines = order.shipping_order_lines ?? [];
    const hasOpenLine = lines.some((line) => line.fulfillment_status !== "FULFILLED" && line.fulfillment_status !== "CANCELLED");
    const hasWarehouseLine = lines.some((line) => ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(line.warehouse_status ?? ""));
    const hasShippedLine = lines.some((line) => line.fulfillment_status === "PARTIALLY_FULFILLED" || line.fulfillment_status === "FULFILLED");
    return hasOpenLine && !hasWarehouseLine && !hasShippedLine;
  }).length;

  const openQueuedOrders = orderRows.filter((order) => {
    const lines = order.shipping_order_lines ?? [];
    const fulfilled = lines.length > 0 && lines.every((line) => line.fulfillment_status === "FULFILLED");
    return lines.some((line) => line.fulfillment_status !== "FULFILLED" && line.fulfillment_status !== "CANCELLED") && !fulfilled;
  }).length;

  const inWarehouseOrderIds = new Set<string>();
  const shippedOrderIds = new Set<string>();
  const fulfilledOrderIds = new Set<string>();

  for (const order of orderRows) {
    const lines = order.shipping_order_lines ?? [];
    if (lines.some((line) => line.warehouse_status === "IN_WAREHOUSE" || line.warehouse_status === "PICKED" || line.warehouse_status === "READY_TO_SHIP")) {
      inWarehouseOrderIds.add(order.id);
    }
    if (lines.some((line) => line.fulfillment_status === "PARTIALLY_FULFILLED" || line.fulfillment_status === "FULFILLED")) {
      shippedOrderIds.add(order.id);
    }
    if (lines.length > 0 && lines.every((line) => line.fulfillment_status === "FULFILLED")) {
      fulfilledOrderIds.add(order.id);
    }
  }

  const inWarehouse = inWarehouseOrderIds.size;
  const shippedInTransit = shippedOrderIds.size;
  const fulfilledOrders = fulfilledOrderIds.size;

  const activeContainers = containerRows.filter((container) => {
    const status = container.lifecycle_status ?? "";
    return status === "ORDERED" || status === "PRODUCTION" || status === "INBOUND";
  }).length;
  const inProduction = containerRows.filter((container) => container.lifecycle_status === "PRODUCTION").length;
  const inbound = containerRows.filter((container) => container.lifecycle_status === "INBOUND").length;

  const nextArrivalContainer = containerRows
    .filter((container) => {
      const status = container.lifecycle_status ?? "";
      return status === "ORDERED" || status === "PRODUCTION" || status === "INBOUND";
    })
    .map((container) => ({ container, eta: getContainerEtaDate(container) }))
    .filter((entry): entry is { container: ContainerRow; eta: Date } => Boolean(entry.eta))
    .sort((a, b) => a.eta.getTime() - b.eta.getTime())[0];

  const openCases = caseRows.filter((row) => !isResolvedCase(row.status)).length;
  const highPriorityCases = caseRows.filter((row) => row.priority === "High" && !isResolvedCase(row.status)).length;
  const installationsNeedingAttention = installationRows.filter((row) => needsInstallationAttention(row.status)).length;

  const activityItems: ActivityItem[] = [];

  for (const row of auditRows) {
    if (row.entity_type !== "shipping_order" || !row.entity_id) continue;

    let title = "Order updated";
    if (row.action === "ORDER_LINE_APPROVED") title = "Order accepted";
    if (row.action === "ORDER_LINE_QUEUED") title = "Order marked in warehouse";
    if (row.action === "ORDER_LINE_FULFILLED") title = "Order shipped";

    activityItems.push({
      id: `audit-${row.id}`,
      title,
      subtitle: `Order ${row.entity_id.slice(0, 8)}`,
      href: `/orders/${row.entity_id}`,
      createdAt: row.created_at,
    });
  }

  for (const row of containerRows.slice(0, 20)) {
    activityItems.push({
      id: `container-${row.id}`,
      title: row.lifecycle_status === "RECEIVED" ? "Container received" : "Container added",
      subtitle: row.container_number ?? "Container",
      href: `/containers/${row.id}`,
      createdAt: row.updated_at || row.created_at,
    });
  }

  for (const row of transactionRows.slice(0, 20)) {
    activityItems.push({
      id: `inventory-${row.product_id ?? "unknown"}-${row.created_at}`,
      title: "Inventory changed",
      subtitle: `${row.bucket ?? "Bucket"} ${Number(row.delta ?? 0) >= 0 ? "+" : ""}${Number(row.delta ?? 0)}`,
      href: "/inventory",
      createdAt: row.created_at,
    });
  }

  for (const row of caseRows.slice(0, 20)) {
    const title = row.priority === "High" ? "New high priority case created" : row.status === "New" ? "New service case created" : "Service case updated";
    activityItems.push({
      id: `case-${row.id}`,
      title,
      subtitle: row.case_number,
      href: `/cases/${row.id}`,
      createdAt: row.updated_at,
    });
  }

  const recentActivity = activityItems
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 12);

  const quickActions = [
    { label: "Create New Case", href: "/cases/new" },
    { label: "Freight Claims", href: "/freight-claims" },
    { label: "Add Container", href: "/containers#add-container" },
    { label: "New Order Note", href: "/orders?tab=new" },
    { label: "Upload Document", href: "/cases" },
  ];

  const alertItems = [
    {
      id: "inv",
      title: `${formatNumber(lowOutOfStock)} SKUs are low or out of stock`,
      href: "/inventory",
      action: "View Inventory",
    },
    {
      id: "order",
      title: `${formatNumber(newOrders)} orders waiting for shipping review`,
      href: "/orders?tab=new",
      action: "View Orders",
    },
    {
      id: "eta",
      title: nextArrivalContainer
        ? `${nextArrivalContainer.container.container_number ?? "Container"} arriving ${formatDate(nextArrivalContainer.eta.toISOString())}`
        : "No active arrival ETA",
      href: "/containers",
      action: "View Containers",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Dashboard</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">Company overview at a glance.</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_270px]">
        <div className="space-y-4">
          <section className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
            <article className="flex h-full flex-col rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.08em] text-[#1f3f9c]">📦 Inventory</p>
              <div className="mt-3 flex-1 space-y-2 text-sm">
                <Link href="/inventory" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#1f3f9c]"><span>Available Inventory</span><span className="font-semibold text-[#1d4ed8]">{formatNumber(availableInventory)}</span></Link>
                <Link href="/inventory" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#1f3f9c]"><span>Low / Out of Stock SKUs</span><span className="font-semibold text-[#dc2626]">{formatNumber(lowOutOfStock)}</span></Link>
                <Link href="/inventory" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#1f3f9c]"><span>Incoming Inventory</span><span className="font-semibold text-[#2563eb]">{formatNumber(incomingInventory)}</span></Link>
                <Link href="/inventory" className="flex items-center justify-between hover:text-[#1f3f9c]"><span>On Floor Inventory</span><span className="font-semibold text-[#2563eb]">{formatNumber(onFloorInventory)}</span></Link>
              </div>
              <Link href="/inventory" className="mt-auto inline-flex pt-4 text-sm font-semibold text-[#2563eb] hover:underline">View Inventory</Link>
            </article>

            <article className="flex h-full flex-col rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.08em] text-[#047857]">📋 Orders</p>
              <div className="mt-3 flex-1 space-y-2 text-sm">
                <Link href="/orders?tab=new" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#047857]"><span>New Orders</span><span className="font-semibold text-[#047857]">{formatNumber(newOrders)}</span></Link>
                <Link href="/orders?tab=orders" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#047857]"><span>Orders</span><span className="font-semibold text-[#047857]">{formatNumber(openQueuedOrders)}</span></Link>
                <Link href="/orders?tab=warehouse" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#047857]"><span>In Warehouse</span><span className="font-semibold text-[#d97706]">{formatNumber(inWarehouse)}</span></Link>
                <Link href="/orders?tab=partial" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#047857]"><span>Partially Shipped</span><span className="font-semibold text-[#2563eb]">{formatNumber(shippedInTransit)}</span></Link>
                <Link href="/orders?tab=archived" className="flex items-center justify-between hover:text-[#047857]"><span>Archived</span><span className="font-semibold text-[#059669]">{formatNumber(fulfilledOrders)}</span></Link>
              </div>
              <Link href="/orders" className="mt-auto inline-flex pt-4 text-sm font-semibold text-[#059669] hover:underline">View Orders</Link>
            </article>

            <article className="flex h-full flex-col rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.08em] text-[#5b21b6]">🚢 Containers</p>
              <div className="mt-3 flex-1 space-y-2 text-sm">
                <Link href="/containers" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#5b21b6]"><span>Active Containers</span><span className="font-semibold text-[#5b21b6]">{formatNumber(activeContainers)}</span></Link>
                <Link href="/containers" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#5b21b6]"><span>In Production</span><span className="font-semibold text-[#5b21b6]">{formatNumber(inProduction)}</span></Link>
                <Link href="/containers" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#5b21b6]"><span>Inbound</span><span className="font-semibold text-[#5b21b6]">{formatNumber(inbound)}</span></Link>
                <Link href="/containers" className="flex items-center justify-between hover:text-[#5b21b6]"><span>Next Arrival</span><span className="font-semibold text-[#7c3aed]">{nextArrivalContainer?.container.container_number ?? "Pending"}</span></Link>
                <p className="text-xs text-[#6b7280]">ETA: {nextArrivalContainer ? formatDate(nextArrivalContainer.eta.toISOString()) : "Pending"}</p>
              </div>
              <Link href="/containers" className="mt-auto inline-flex pt-4 text-sm font-semibold text-[#7c3aed] hover:underline">View Containers</Link>
            </article>

            <article className="flex h-full flex-col rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold uppercase tracking-[0.08em] text-[#b91c1c]">🛠 Service</p>
              <div className="mt-3 flex-1 space-y-2 text-sm">
                <Link href="/cases" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#b91c1c]"><span>Open Cases</span><span className="font-semibold text-[#dc2626]">{formatNumber(openCases)}</span></Link>
                <Link href="/cases?priority=High" className="flex items-center justify-between border-b border-[#eef1f4] pb-2 hover:text-[#b91c1c]"><span>High Priority Cases</span><span className="font-semibold text-[#dc2626]">{formatNumber(highPriorityCases)}</span></Link>
                <Link href="/installation?status=attention" className="flex items-center justify-between hover:text-[#b91c1c]"><span>Installations Needing Attention</span><span className="font-semibold text-[#dc2626]">{formatNumber(installationsNeedingAttention)}</span></Link>
              </div>
              <Link href="/cases" className="mt-auto inline-flex pt-4 text-sm font-semibold text-[#dc2626] hover:underline">View Service Dashboard</Link>
            </article>
          </section>

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold text-[#111827]">Recent Activity</h2>
              <Link href="/dashboard" className="text-sm font-semibold text-[#2563eb] hover:underline">View All Activity</Link>
            </div>
            {recentActivity.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-5 text-sm text-[#6b7280]">No recent activity yet.</div>
            ) : (
              <div className="divide-y divide-[#eef2f6]">
                {recentActivity.map((item) => (
                  <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-[#111827]">{item.title}</p>
                      <p className="text-sm text-[#6b7280]">{item.subtitle}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <p className="text-xs text-[#6b7280]">{formatRelative(item.createdAt)}</p>
                      <Link href={item.href} className="text-sm font-semibold text-[#2563eb] hover:underline">View</Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-4">
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

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#111827]">Alerts</h2>
            <div className="mt-3 space-y-2">
              {alertItems.map((alert) => (
                <div key={alert.id} className="rounded-xl border border-[#e5e7eb] bg-[#f9fafb] p-3">
                  <p className="text-sm font-medium text-[#111827]">{alert.title}</p>
                  <Link href={alert.href} className="mt-1 inline-flex text-xs font-semibold text-[#2563eb] hover:underline">{alert.action}</Link>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
