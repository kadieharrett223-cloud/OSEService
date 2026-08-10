import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type ProductRow = {
  id: string;
};

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
  created_at: string;
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
    { data: containers },
    { data: containerLines },
    { data: orders },
    { data: cases },
    { data: installations },
    { data: audits },
  ] = await Promise.all([
    supabase.from("products").select("id"),
    supabase.from("inventory_transactions").select("product_id, bucket, delta, created_at").order("created_at", { ascending: false }).limit(60),
    supabase
      .from("containers")
      .select("id, container_number, lifecycle_status, created_at, updated_at, entered_date, eta_confirmed_date, eta_estimated_date")
      .order("updated_at", { ascending: false })
      .limit(80),
    supabase.from("container_lines").select("container_id, on_order_qty"),
    supabase
      .from("shipping_orders")
      .select(`
        id,
        review_status,
        qbo_invoices (payment_status),
        shipping_order_lines (approval_status, warehouse_status, fulfillment_status)
      `)
      .order("created_at", { ascending: false })
      .limit(120),
    supabase.from("customer_service_cases").select("id, case_number, status, priority, created_at, updated_at").order("updated_at", { ascending: false }).limit(80),
    supabase.from("installation_jobs").select("id, status").order("updated_at", { ascending: false }).limit(80),
    supabase.from("audit_log").select("id, entity_type, entity_id, action, created_at").order("created_at", { ascending: false }).limit(80),
  ]);

  const productRows = (products ?? []) as ProductRow[];
  const transactionRows = (inventoryTransactions ?? []) as InventoryTransactionRow[];
  const containerRows = (containers ?? []) as ContainerRow[];
  const containerLineRows = (containerLines ?? []) as ContainerLineRow[];
  const orderRows = (orders ?? []) as OrderRow[];
  const caseRows = (cases ?? []) as CaseRow[];
  const installationRows = (installations ?? []) as InstallationRow[];
  const auditRows = (audits ?? []) as AuditRow[];

  const inventoryByProduct = new Map<string, { onFloor: number; incomingAvailable: number }>();
  for (const row of transactionRows) {
    if (!row.product_id) continue;
    const existing = inventoryByProduct.get(row.product_id) ?? { onFloor: 0, incomingAvailable: 0 };
    const delta = Number(row.delta ?? 0);
    if (row.bucket === "ON_FLOOR") existing.onFloor += delta;
    if (row.bucket === "INCOMING_AVAILABLE") existing.incomingAvailable += delta;
    inventoryByProduct.set(row.product_id, existing);
  }

  const availableInventory = Array.from(inventoryByProduct.values()).reduce((sum, row) => sum + row.onFloor + row.incomingAvailable, 0);

  const lowOutOfStock = productRows.filter((product) => {
    const metrics = inventoryByProduct.get(product.id) ?? { onFloor: 0, incomingAvailable: 0 };
    return metrics.onFloor + metrics.incomingAvailable <= 5;
  }).length;

  const activeContainerIds = new Set(
    containerRows.filter((container) => {
      const status = container.lifecycle_status ?? "";
      return status === "ORDERED" || status === "PRODUCTION" || status === "INBOUND";
    }).map((container) => container.id),
  );

  const incomingInventory = containerLineRows.reduce((sum, line) => {
    if (!line.container_id || !activeContainerIds.has(line.container_id)) return sum;
    return sum + Number(line.on_order_qty ?? 0);
  }, 0);

  const newOrders = orderRows.filter((order) => {
    const paid = order.qbo_invoices?.payment_status === "Paid";
    return paid && order.review_status === "PENDING_REVIEW";
  }).length;

  const openQueuedOrders = orderRows.filter((order) => {
    const accepted = order.review_status === "APPROVED" || (order.shipping_order_lines ?? []).some((line) => line.approval_status === "APPROVED");
    const lines = order.shipping_order_lines ?? [];
    const fulfilled = lines.length > 0 && lines.every((line) => line.fulfillment_status === "FULFILLED");
    return accepted && !fulfilled;
  }).length;

  const inWarehouseOrderIds = new Set<string>();
  const shippedOrderIds = new Set<string>();

  for (const order of orderRows) {
    const lines = order.shipping_order_lines ?? [];
    if (lines.some((line) => line.warehouse_status === "IN_WAREHOUSE" || line.warehouse_status === "PICKED" || line.warehouse_status === "READY_TO_SHIP")) {
      inWarehouseOrderIds.add(order.id);
    }
    if (lines.some((line) => line.fulfillment_status === "PARTIALLY_FULFILLED" || line.fulfillment_status === "FULFILLED")) {
      shippedOrderIds.add(order.id);
    }
  }

  const inWarehouse = inWarehouseOrderIds.size;
  const shippedInTransit = shippedOrderIds.size;

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
    .map((container) => ({
      container,
      eta: getContainerEtaDate(container),
    }))
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
    const title = row.priority === "High" ? "High-priority service case" : row.status === "New" ? "New service case" : "Service case updated";
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
    .slice(0, 14);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Dashboard</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">Company-wide operational overview with direct links to each workflow area.</p>
      </div>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-[#111827]">Inventory</h2>
          <Link href="/inventory" className="text-sm font-semibold text-[#d50917] hover:underline">Open Inventory</Link>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Link href="/inventory" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Available Inventory</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{availableInventory}</p>
          </Link>
          <Link href="/inventory" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Low / Out of Stock</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{lowOutOfStock}</p>
          </Link>
          <Link href="/inventory" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Incoming Inventory</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{incomingInventory}</p>
          </Link>
        </div>
      </section>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-[#111827]">Orders</h2>
          <Link href="/orders" className="text-sm font-semibold text-[#d50917] hover:underline">Open Orders</Link>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Link href="/orders?tab=new" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">New Orders</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{newOrders}</p>
          </Link>
          <Link href="/orders?tab=accepted" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Open / Queued</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{openQueuedOrders}</p>
          </Link>
          <Link href="/orders?tab=warehouse" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">In Warehouse</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{inWarehouse}</p>
          </Link>
          <Link href="/orders?tab=shipped" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Shipped / In Transit</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{shippedInTransit}</p>
          </Link>
        </div>
      </section>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-[#111827]">Containers</h2>
          <Link href="/containers" className="text-sm font-semibold text-[#d50917] hover:underline">Open Containers</Link>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Link href="/containers" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Active Containers</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{activeContainers}</p>
          </Link>
          <Link href="/containers" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">In Production</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{inProduction}</p>
          </Link>
          <Link href="/containers" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Inbound</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{inbound}</p>
          </Link>
          <Link href="/containers" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Next Arrival</p>
            <p className="mt-1 text-lg font-semibold text-[#111827]">{nextArrivalContainer?.container.container_number ?? "Pending"}</p>
            <p className="text-xs text-[#6b7280]">ETA {nextArrivalContainer ? formatDate(nextArrivalContainer.eta.toISOString()) : "Pending"}</p>
          </Link>
        </div>
      </section>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-[#111827]">Service</h2>
          <Link href="/cases" className="text-sm font-semibold text-[#d50917] hover:underline">Open Service</Link>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Link href="/cases" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Open Cases</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{openCases}</p>
          </Link>
          <Link href="/cases?priority=High" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">High Priority Cases</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{highPriorityCases}</p>
          </Link>
          <Link href="/installation?status=attention" className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4 hover:bg-[#f5f7fa]">
            <p className="text-sm text-[#6b7280]">Installations Needing Attention</p>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{installationsNeedingAttention}</p>
          </Link>
        </div>
      </section>

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-[#111827]">Recent Activity</h2>
          <p className="text-sm text-[#6b7280]">Latest cross-team operational events</p>
        </div>

        {recentActivity.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-5 text-sm text-[#6b7280]">
            No recent activity yet.
          </div>
        ) : (
          <div className="space-y-2">
            {recentActivity.map((item) => (
              <Link key={item.id} href={item.href} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#e5e7eb] bg-[#fafbfc] px-4 py-3 hover:bg-[#f5f7fa]">
                <div>
                  <p className="font-semibold text-[#111827]">{item.title}</p>
                  <p className="text-sm text-[#6b7280]">{item.subtitle}</p>
                </div>
                <p className="text-xs text-[#6b7280]">{formatRelative(item.createdAt)}</p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
