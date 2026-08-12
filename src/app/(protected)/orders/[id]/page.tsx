import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  addOrderNoteAction,
  deleteOrderAttachmentAction,
  markOrderLineShippedAction,
  updateOrderLineAssignmentAction,
  updateOrderLineStatusAction,
  updateOrderScheduleAction,
  uploadOrderAttachmentAction,
} from "../actions";

type OrderDetailRow = {
  id: string;
  order_number: string | null;
  source_invoice_id: string | null;
  legacy_customer_name: string | null;
  review_status: string | null;
  promised_ship_date: string | null;
  shipping_method: string | null;
  notes: string | null;
  tracking_number: string | null;
  carrier: string | null;
  created_at: string;
  customers?: { company_name: string | null; full_name: string | null; email: string | null; phone: string | null } | null;
  qbo_invoices?: {
    id: string;
    invoice_number: string | null;
    payment_status: string | null;
    invoice_date: string | null;
    total_amount: number | null;
    raw_payload?: unknown;
  } | null;
  shipping_order_lines?: Array<{
    id: string;
    ordered_qty: number | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    approval_status: string | null;
    warehouse_status: string | null;
    fulfillment_status: string | null;
    allocation_status: string | null;
    priority: string | null;
    queue_position_start: number | null;
    legacy_container_assignment: string | null;
    suggested_assignment_source: string | null;
    suggested_container_id: string | null;
    products?: { sku: string | null; canonical_name: string | null } | null;
    inventory_allocations?: Array<{
      quantity: number | null;
      source_type: string | null;
      container_id: string | null;
      containers?: {
        id: string;
        container_number: string | null;
        lifecycle_status: string | null;
        eta_confirmed_date: string | null;
        eta_estimated_date: string | null;
      } | null;
    }>;
  }>;
};

type ContainerOption = {
  id: string;
  container_number: string | null;
  lifecycle_status: string | null;
  eta_confirmed_date: string | null;
  eta_estimated_date: string | null;
};

type OrderActivityEntry = {
  id: string;
  action: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

type OrderAttachmentEntry = {
  id: string;
  file_name: string | null;
  file_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
};

type FulfillmentEntry = {
  id: string;
  shipping_order_line_id: string;
  fulfilled_qty: number | null;
  fulfilled_at: string;
  shipment_number: string | null;
  carrier: string | null;
  tracking_number: string | null;
  reason: string | null;
};

type QuickbooksInvoiceSnapshot = {
  id: string;
  invoice_number: string | null;
  payment_status: string | null;
  invoice_date: string | null;
  total_amount: number | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  raw_payload?: unknown;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseSalesperson(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const payload = rawPayload as Record<string, unknown>;
  const salesrep = payload.SalesRepRef as { name?: unknown } | undefined;
  return typeof salesrep?.name === "string" ? salesrep.name : null;
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value));
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending";
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function metricStatusClass(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "APPROVED" || normalized === "PAID" || normalized === "FULFILLED") return "bg-[#e7f7ed] text-[#1b7a43]";
  if (normalized === "PENDING" || normalized === "PARTIALLY_FULFILLED") return "bg-[#fff7e6] text-[#b45309]";
  if (normalized === "HOLD") return "bg-[#fee2e2] text-[#b91c1c]";
  return "bg-[#eef2f7] text-[#334155]";
}

function parseInvoiceLineItems(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return [] as string[];

  const payload = rawPayload as { Line?: unknown[] };
  const lines = Array.isArray(payload.Line) ? payload.Line : [];

  return lines
    .map((line, index) => {
      if (!line || typeof line !== "object") return null;

      const item = line as {
        Description?: unknown;
        Qty?: unknown;
        Amount?: unknown;
        SalesItemLineDetail?: { Qty?: unknown; ItemRef?: { name?: unknown } };
      };

      const description = typeof item.Description === "string"
        ? item.Description.trim()
        : typeof item.SalesItemLineDetail?.ItemRef?.name === "string"
          ? item.SalesItemLineDetail.ItemRef.name.trim()
          : "";

      if (!description) return null;

      const qtyRaw = item.SalesItemLineDetail?.Qty ?? item.Qty;
      const qty = typeof qtyRaw === "number" || typeof qtyRaw === "string" ? String(qtyRaw).trim() : "";
      const amount = typeof item.Amount === "number" ? formatCurrency(item.Amount) : null;

      return `${index + 1}. ${description}${qty ? ` (Qty ${qty})` : ""}${amount ? ` - ${amount}` : ""}`;
    })
    .filter((line): line is string => Boolean(line));
}

function formatAssignmentSource(line: NonNullable<OrderDetailRow["shipping_order_lines"]>[number]) {
  const allocations = line.inventory_allocations ?? [];
  if (allocations.length === 0) return "Unassigned";

  return allocations.map((allocation) => {
    const qty = Number(allocation.quantity ?? 0);
    if (allocation.source_type === "FLOOR") {
      return `${qty} from On Floor`;
    }

    if (allocation.source_type === "CONTAINER") {
      const number = allocation.containers?.container_number ?? "Container";
      const status = formatStatus(allocation.containers?.lifecycle_status);
      const eta = formatDate(allocation.containers?.eta_confirmed_date ?? allocation.containers?.eta_estimated_date);
      return `${qty} from ${number} (${status} · ETA ${eta})`;
    }

    return `${qty} from Unassigned`;
  }).join("; ");
}

function formatSuggestedAssignment(
  line: NonNullable<OrderDetailRow["shipping_order_lines"]>[number],
  containersById: Map<string, ContainerOption>,
) {
  if (line.suggested_assignment_source === "FLOOR") {
    return "Suggested from legacy backlog: On Floor";
  }

  if (line.suggested_assignment_source === "CONTAINER" && line.suggested_container_id) {
    const container = containersById.get(line.suggested_container_id);
    if (container) {
      const eta = formatDate(container.eta_confirmed_date ?? container.eta_estimated_date);
      return `Suggested from legacy backlog: ${container.container_number ?? "Container"} (${formatStatus(container.lifecycle_status)} · ETA ${eta})`;
    }
    return "Suggested from legacy backlog: Active container match";
  }

  if (line.legacy_container_assignment) {
    return `Legacy container assignment preserved: ${line.legacy_container_assignment}`;
  }

  return "No legacy assignment suggestion";
}

function summarizeAllocation(line: NonNullable<OrderDetailRow["shipping_order_lines"]>[number]) {
  const allocations = line.inventory_allocations ?? [];
  if (allocations.length === 0) return { label: "UNALLOCATED", detail: "—" };

  return {
    label: line.allocation_status ?? "ALLOCATED",
    detail: allocations.map((allocation) => {
      const qty = Number(allocation.quantity ?? 0);
      if (allocation.source_type === "CONTAINER") {
        const container = allocation.containers?.container_number ?? "Container";
        const eta = formatDate(allocation.containers?.eta_confirmed_date ?? allocation.containers?.eta_estimated_date);
        return `${container} · ${qty} · ETA ${eta}`;
      }
      return `On Floor · ${qty}`;
    }).join("; "),
  };
}

function getQuickbooksLineDescriptions(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return [] as string[];

  const payload = rawPayload as { Line?: unknown[] };
  const lines = Array.isArray(payload.Line) ? payload.Line : [];

  return lines
    .map((line) => {
      if (!line || typeof line !== "object") return null;

      const item = line as {
        Description?: unknown;
        SalesItemLineDetail?: { ItemRef?: { name?: unknown } };
      };

      if (typeof item.Description === "string" && item.Description.trim()) {
        return item.Description.trim();
      }

      if (typeof item.SalesItemLineDetail?.ItemRef?.name === "string" && item.SalesItemLineDetail.ItemRef.name.trim()) {
        return item.SalesItemLineDetail.ItemRef.name.trim();
      }

      return null;
    })
    .filter((value): value is string => Boolean(value));
}

function deriveOverallOrderStatus(lines: NonNullable<OrderDetailRow["shipping_order_lines"]>) {
  if (lines.length === 0) return "Pending";
  const allFulfilled = lines.every((line) => (line.fulfillment_status ?? "PENDING") === "FULFILLED");
  if (allFulfilled) return "Fulfilled";
  if (lines.some((line) => (line.warehouse_status ?? "") === "IN_WAREHOUSE")) return "In Warehouse";
  if (lines.some((line) => (line.fulfillment_status ?? "") === "PARTIALLY_FULFILLED")) return "Partially Shipped";
  if (lines.some((line) => (line.approval_status ?? "") === "HOLD")) return "Hold";
  return "Approved";
}

async function loadTableColumnSet(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  tableName: string,
  candidates: string[],
) {
  const columns = new Set<string>();

  for (const column of candidates) {
    const { error } = await supabase.from(tableName).select(column).limit(1);
    if (!error) {
      columns.add(column);
    }
  }

  return columns;
}

function buildShippingOrderSelect(columnSet: Set<string>) {
  const columns = [
    "id",
    "order_number",
    "source_invoice_id",
    "legacy_customer_name",
    "review_status",
    "created_at",
  ];

  if (columnSet.has("promised_ship_date")) columns.push("promised_ship_date");
  if (columnSet.has("shipping_method")) columns.push("shipping_method");
  if (columnSet.has("notes")) columns.push("notes");
  if (columnSet.has("tracking_number")) columns.push("tracking_number");
  if (columnSet.has("carrier")) columns.push("carrier");

  columns.push(
    "customers (company_name, full_name, email, phone)",
    "qbo_invoices (id, invoice_number, payment_status, invoice_date, total_amount, raw_payload)",
    `shipping_order_lines (
      id,
      ordered_qty,
      approved_qty,
      fulfilled_qty,
      approval_status,
      warehouse_status,
      fulfillment_status,
      allocation_status,
      priority,
      queue_position_start,
      legacy_container_assignment,
      suggested_assignment_source,
      suggested_container_id,
      products (sku, canonical_name),
      inventory_allocations (
        quantity,
        source_type,
        container_id,
        containers (id, container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date)
      )
    )`,
  );

  return columns.join(",\n        ");
}

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const { id } = await params;
  const { error, message } = await searchParams;

  const shippingOrderColumnSet = await loadTableColumnSet(supabase, "shipping_orders", [
    "promised_ship_date",
    "shipping_method",
    "notes",
    "tracking_number",
    "carrier",
  ]);
  const hasOrderAttachmentsTable = (await loadTableColumnSet(supabase, "order_attachments", ["id"])).has("id");
  const shippingOrderSelect = buildShippingOrderSelect(shippingOrderColumnSet);

  const [{ data: order }, { data: activityRows }, attachmentResult, { data: containerRows }] = await Promise.all([
    supabase
      .from("shipping_orders")
      .select(shippingOrderSelect)
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("audit_log")
      .select("id, action, details, created_at")
      .eq("entity_type", "shipping_order")
      .eq("entity_id", id)
      .order("created_at", { ascending: false }),
    hasOrderAttachmentsTable
      ? supabase
          .from("order_attachments")
          .select("id, file_name, file_path, file_size, mime_type, created_at")
          .eq("shipping_order_id", id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as OrderAttachmentEntry[] }),
    supabase
      .from("containers")
      .select("id, container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date")
      .in("lifecycle_status", ["ORDERED", "PRODUCTION", "INBOUND", "RECEIVED"])
      .order("eta_confirmed_date", { ascending: true, nullsFirst: false }),
  ]);

  const orderRecord = order as OrderDetailRow | null;
  const activities = (activityRows ?? []) as OrderActivityEntry[];
  const attachments = (attachmentResult.data ?? []) as OrderAttachmentEntry[];

  if (!orderRecord) {
    return <div className="p-6">Order not found.</div>;
  }

  let quickbooksSnapshot = (orderRecord.qbo_invoices as QuickbooksInvoiceSnapshot | null | undefined) ?? null;
  if (!quickbooksSnapshot && orderRecord.order_number) {
    const { data: fallbackInvoice } = await supabase
      .from("qbo_invoices")
      .select("id, invoice_number, payment_status, invoice_date, total_amount, billing_address, shipping_address, raw_payload")
      .eq("invoice_number", orderRecord.order_number)
      .limit(1)
      .maybeSingle();

    quickbooksSnapshot = (fallbackInvoice as QuickbooksInvoiceSnapshot | null) ?? null;
  }

  if (!quickbooksSnapshot && orderRecord.order_number) {
    const { data: legacyInvoice } = await supabase
      .from("quickbooks_invoices")
      .select("id, invoice_number, payment_status, invoice_date, invoice_total, billing_address, shipping_address, raw_payload")
      .eq("invoice_number", orderRecord.order_number)
      .limit(1)
      .maybeSingle();

    if (legacyInvoice) {
      quickbooksSnapshot = {
        id: legacyInvoice.id,
        invoice_number: legacyInvoice.invoice_number,
        payment_status: legacyInvoice.payment_status,
        invoice_date: legacyInvoice.invoice_date,
        total_amount: legacyInvoice.invoice_total,
        billing_address: legacyInvoice.billing_address,
        shipping_address: legacyInvoice.shipping_address,
        raw_payload: legacyInvoice.raw_payload,
      };
    }
  }

  const quickbooksLineItems = parseInvoiceLineItems(quickbooksSnapshot?.raw_payload);
  const quickbooksDescriptions = getQuickbooksLineDescriptions(quickbooksSnapshot?.raw_payload);

  const containerOptions = (containerRows ?? []) as ContainerOption[];
  const containersById = new Map(containerOptions.map((container) => [container.id, container]));
  const salesperson = parseSalesperson(quickbooksSnapshot?.raw_payload);
  const orderLines = (orderRecord.shipping_order_lines ?? []).slice().sort((left, right) => {
    const leftQueue = left.queue_position_start ?? Number.MAX_SAFE_INTEGER;
    const rightQueue = right.queue_position_start ?? Number.MAX_SAFE_INTEGER;
    if (leftQueue !== rightQueue) return leftQueue - rightQueue;
    return (left.products?.sku ?? "").localeCompare(right.products?.sku ?? "");
  });

  const lineIds = orderLines.map((line) => line.id);
  const { data: fulfillmentRows } = lineIds.length
    ? await supabase
        .from("fulfillments")
        .select("id, shipping_order_line_id, fulfilled_qty, fulfilled_at, shipment_number, carrier, tracking_number, reason")
        .in("shipping_order_line_id", lineIds)
        .order("fulfilled_at", { ascending: false })
    : { data: [] };

  const fulfillments = (fulfillmentRows ?? []) as FulfillmentEntry[];
  const fulfillmentsByLine = fulfillments.reduce<Record<string, FulfillmentEntry[]>>((acc, fulfillment) => {
    if (!acc[fulfillment.shipping_order_line_id]) {
      acc[fulfillment.shipping_order_line_id] = [];
    }
    acc[fulfillment.shipping_order_line_id].push(fulfillment);
    return acc;
  }, {});

  const activityCount = activities.length;
  const noteCount = activities.filter((activity) => activity.action === "ORDER_NOTE_ADDED").length;
  const shipmentCount = fulfillments.length;
  const lineItemCount = orderLines.length;
  const orderedQtyTotal = orderLines.reduce((sum, line) => sum + Number(line.ordered_qty ?? 0), 0);
  const openQtyTotal = orderLines.reduce((sum, line) => sum + Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)), 0);
  const shippedQtyTotal = orderLines.reduce((sum, line) => sum + Number(line.fulfilled_qty ?? 0), 0);
  const unallocatedLines = orderLines.filter((line) => (line.inventory_allocations?.length ?? 0) === 0).length;
  const allocatedLines = orderLines.filter((line) => (line.inventory_allocations?.length ?? 0) > 0).length;
  const overallStatus = deriveOverallOrderStatus(orderLines);

  const lineHistoryById = activities.reduce<Record<string, OrderActivityEntry[]>>((acc, activity) => {
    const lineId = typeof activity.details?.line_id === "string" ? activity.details.line_id : null;
    if (!lineId) return acc;
    if (!acc[lineId]) {
      acc[lineId] = [];
    }
    acc[lineId].push(activity);
    return acc;
  }, {});

  const orderSourceLabel = orderRecord.source_invoice_id ? "QuickBooks" : "OLD_ERP";
  const importTimestamp = activities.find((activity) => activity.action === "ORDER_IMPORTED")?.created_at ?? orderRecord.created_at;

  const attachmentLinks = await Promise.all(
    attachments.map(async (attachment) => {
      if (!attachment.file_path) return null;
      const { data } = await supabase.storage.from("case-attachments").createSignedUrl(attachment.file_path, 60 * 60);
      return {
        ...attachment,
        signedUrl: data?.signedUrl ?? null,
      };
    }),
  );

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</div>
      ) : null}

      {message ? (
        <div className="rounded-lg border border-[#bfdcc5] bg-[#f3fff6] p-3 text-sm text-[#0f5b28]">{message}</div>
      ) : null}

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Orders & Shipping</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Order Detail</h1>
            <p className="mt-2 text-sm text-[#5a5a5a]">Operational workflow for shipping review, warehouse, assignment, shipment, and history.</p>
          </div>
          <Link href="/orders" className="btn-secondary inline-flex">Back to orders</Link>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="grid gap-6 xl:grid-cols-[1.7fr_0.9fr]">
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6b7280]">Customer</p>
              <p className="mt-2 text-lg font-semibold text-[#111827]">{orderRecord.customers?.company_name ?? orderRecord.customers?.full_name ?? orderRecord.legacy_customer_name ?? "Customer pending"}</p>
              <p className="mt-1 text-sm text-[#5a5a5a]">{orderRecord.customers?.email ?? "No email"}</p>
              <p className="text-sm text-[#5a5a5a]">{orderRecord.customers?.phone ?? "No phone"}</p>
              <p className="mt-2 text-sm text-[#5a5a5a]">{quickbooksSnapshot?.shipping_address ?? "Shipping address unavailable"}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6b7280]">Invoice</p>
              <p className="mt-2 text-lg font-semibold text-[#111827]">#{quickbooksSnapshot?.invoice_number ?? orderRecord.order_number ?? "—"}</p>
              <p className="mt-1 text-sm text-[#5a5a5a]">{formatDate(quickbooksSnapshot?.invoice_date)}</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#6b7280]">Source</p>
              <span className="mt-2 inline-flex rounded-full bg-[#e8fff2] px-2.5 py-1 text-xs font-semibold text-[#18794e]">{orderSourceLabel}{orderRecord.source_invoice_id ? " Linked" : " Import"}</span>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6b7280]">Status</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${metricStatusClass(orderRecord.review_status)}`}>{orderRecord.review_status ?? "PENDING"}</span>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${metricStatusClass(overallStatus)}`}>{overallStatus.toUpperCase()}</span>
              </div>
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.08em] text-[#6b7280]">Priority</p>
              <p className="mt-1 text-sm font-semibold text-[#111827]">{orderLines.some((line) => line.priority === "HIGH" || line.priority === "CRITICAL") ? "HIGH" : orderLines[0]?.priority ?? "NORMAL"}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6b7280]">Payment Status</p>
              <span className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${metricStatusClass(quickbooksSnapshot?.payment_status)}`}>{quickbooksSnapshot?.payment_status ?? "Pending"}</span>
              <p className="mt-3 text-xs font-semibold uppercase tracking-[0.08em] text-[#6b7280]">Total</p>
              <p className="mt-1 text-sm font-semibold text-[#111827]">{formatCurrency(quickbooksSnapshot?.total_amount)}</p>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-xl border border-[#eef2f7] bg-[#fafbfc] p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Warehouse Snapshot</p>
              <div className="mt-3 space-y-2 text-sm text-[#374151]">
                <div className="flex items-center justify-between gap-3"><span>Tracking</span><span className="font-semibold text-[#111827]">{shippingOrderColumnSet.has("tracking_number") ? (orderRecord.tracking_number ?? "Stored on shipments") : "Stored on shipments"}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Carrier</span><span className="font-semibold text-[#111827]">{shippingOrderColumnSet.has("carrier") ? (orderRecord.carrier ?? "Stored on shipments") : "Stored on shipments"}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Salesperson</span><span className="font-semibold text-[#111827]">{salesperson ?? "—"}</span></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2 text-sm font-semibold text-[#475569]">
          <span className="rounded-full bg-[#fff1f2] px-3 py-2 text-[#d50917]">Overview</span>
          <span className="rounded-full bg-[#f8fafc] px-3 py-2">Line Items ({lineItemCount})</span>
          <span className="rounded-full bg-[#f8fafc] px-3 py-2">Allocations ({allocatedLines})</span>
          <span className="rounded-full bg-[#f8fafc] px-3 py-2">Shipments ({shipmentCount})</span>
          <span className="rounded-full bg-[#f8fafc] px-3 py-2">Notes ({noteCount})</span>
          <span className="rounded-full bg-[#f8fafc] px-3 py-2">History ({activityCount})</span>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.7fr_0.9fr]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-[#111827]">Line Items ({lineItemCount})</h2>
                <p className="mt-1 text-sm text-[#5a5a5a]">Every physical order line carries its own warehouse status, allocations, shipments, and history.</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-semibold text-[#475569]">
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">Ordered {orderedQtyTotal}</span>
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">Open {openQtyTotal}</span>
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">Shipped {shippedQtyTotal}</span>
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">Backordered {openQtyTotal}</span>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[#edf2f7] text-xs uppercase tracking-[0.08em] text-[#64748b]">
                    <th className="px-2 py-3">#</th>
                    <th className="px-2 py-3">SKU</th>
                    <th className="px-2 py-3">Description</th>
                    <th className="px-2 py-3">Ordered</th>
                    <th className="px-2 py-3">Open</th>
                    <th className="px-2 py-3">Allocation</th>
                    <th className="px-2 py-3">Suggested Source</th>
                    <th className="px-2 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {orderLines.map((line, index) => {
                    const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
                    const allocationSummary = summarizeAllocation(line);
                    const quickbooksDescription = quickbooksDescriptions[index] ?? line.products?.canonical_name ?? line.products?.sku ?? "Line item";
                    const suggested = formatSuggestedAssignment(line, containersById);
                    const lineHistoryCount = lineHistoryById[line.id]?.length ?? 0;
                    return (
                      <tr key={line.id} className="border-b border-[#f1f5f9] align-top text-[#1f2937]">
                        <td className="px-2 py-3 font-semibold">{index + 1}</td>
                        <td className="px-2 py-3 font-semibold text-[#111827]">{line.products?.sku ?? "SKU"}</td>
                        <td className="px-2 py-3">
                          <p className="font-medium text-[#111827]">{quickbooksDescription}</p>
                          <p className="mt-1 text-xs text-[#64748b]">Warehouse {formatStatus(line.warehouse_status)} · Fulfillment {formatStatus(line.fulfillment_status)}</p>
                        </td>
                        <td className="px-2 py-3">{line.ordered_qty ?? 0}</td>
                        <td className="px-2 py-3">{remainingQty}</td>
                        <td className="px-2 py-3">
                          <span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ${allocationSummary.label === "UNALLOCATED" ? "bg-[#fff1f2] text-[#b91c1c]" : "bg-[#eefbf3] text-[#18794e]"}`}>{allocationSummary.label}</span>
                          <p className="mt-1 text-xs text-[#64748b]">{allocationSummary.detail}</p>
                        </td>
                        <td className="px-2 py-3 text-xs text-[#475569]">{suggested === "No legacy assignment suggestion" ? "—" : suggested}</td>
                        <td className="px-2 py-3">
                          <details className="group min-w-[190px]">
                            <summary className="cursor-pointer rounded-lg border border-[#d9e2f7] bg-white px-3 py-2 text-xs font-semibold text-[#334155]">Manage</summary>
                            <div className="mt-3 space-y-3 rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-3">
                              <div className="flex flex-wrap gap-2">
                                <form action={updateOrderLineStatusAction}>
                                  <input type="hidden" name="lineId" value={line.id} />
                                  <input type="hidden" name="orderId" value={orderRecord.id} />
                                  <input type="hidden" name="action" value="approve" />
                                  <button className="btn-secondary text-xs">Approve</button>
                                </form>
                                <form action={updateOrderLineStatusAction}>
                                  <input type="hidden" name="lineId" value={line.id} />
                                  <input type="hidden" name="orderId" value={orderRecord.id} />
                                  <input type="hidden" name="action" value="queue" />
                                  <button className="btn-secondary text-xs">In Warehouse</button>
                                </form>
                                <form action={updateOrderLineStatusAction}>
                                  <input type="hidden" name="lineId" value={line.id} />
                                  <input type="hidden" name="orderId" value={orderRecord.id} />
                                  <input type="hidden" name="action" value="hold" />
                                  <button className="btn-secondary text-xs">Hold</button>
                                </form>
                              </div>
                              <form action={updateOrderLineAssignmentAction} className="grid gap-2">
                                <input type="hidden" name="orderId" value={orderRecord.id} />
                                <input type="hidden" name="lineId" value={line.id} />
                                <select name="assignment_source" className="select text-xs" defaultValue={line.inventory_allocations?.[0]?.source_type ?? line.suggested_assignment_source ?? "UNASSIGNED"}>
                                  <option value="UNASSIGNED">Unassigned</option>
                                  <option value="FLOOR">On Floor</option>
                                  <option value="CONTAINER">Container</option>
                                </select>
                                <select name="container_id" className="select text-xs" defaultValue={line.inventory_allocations?.[0]?.container_id ?? line.suggested_container_id ?? ""}>
                                  <option value="">Select container</option>
                                  {containerOptions.map((container) => (
                                    <option key={container.id} value={container.id}>
                                      {(container.container_number ?? "Container")} · {formatStatus(container.lifecycle_status)} · ETA {formatDate(container.eta_confirmed_date ?? container.eta_estimated_date)}
                                    </option>
                                  ))}
                                </select>
                                <button className="btn-secondary text-xs" type="submit">Save Allocation</button>
                              </form>
                              <p className="text-[11px] text-[#64748b]">Shipments {fulfillmentsByLine[line.id]?.length ?? 0} · History events {lineHistoryCount}</p>
                            </div>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-[#111827]">Inventory Allocation</h2>
                  <p className="mt-1 text-sm text-[#5a5a5a]">Container assignments, ETA visibility, and suggested sources stay visible right beside each product.</p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs font-semibold text-[#475569]">
                  <span className="rounded-full bg-[#fff1f2] px-3 py-1.5 text-[#b91c1c]">Unallocated ({unallocatedLines})</span>
                  <span className="rounded-full bg-[#eefbf3] px-3 py-1.5 text-[#18794e]">Allocated ({allocatedLines})</span>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {orderLines.map((line) => {
                  const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
                  return (
                    <div key={line.id} className="rounded-xl border border-[#eef2f7] bg-[#fafbfc] p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-[#111827]">{line.products?.sku ?? "SKU pending"}</p>
                          <p className="mt-1 text-sm text-[#5a5a5a]">Open Qty {remainingQty}</p>
                          <p className="mt-1 text-xs text-[#64748b]">Current allocation: {formatAssignmentSource(line)}</p>
                          <p className="mt-1 text-xs text-[#64748b]">Suggested source: {formatSuggestedAssignment(line, containersById)}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm" id="quick-ship">
              <h2 className="text-xl font-semibold text-[#111827]">Quick Ship (Partial Shipment)</h2>
              <p className="mt-1 text-sm text-[#5a5a5a]">Ship selected line items. Remaining quantity stays open for backorder.</p>
              <div className="mt-4 space-y-4">
                {orderLines.map((line) => {
                  const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
                  return (
                    <form key={line.id} action={markOrderLineShippedAction} className="rounded-xl border border-[#eef2f7] bg-[#fafbfc] p-4">
                      <input type="hidden" name="orderId" value={orderRecord.id} />
                      <input type="hidden" name="lineId" value={line.id} />
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-[#111827]">{line.products?.sku ?? "SKU pending"}</p>
                          <p className="mt-1 text-sm text-[#5a5a5a]">Open Qty {remainingQty} · Shipped {line.fulfilled_qty ?? 0}</p>
                        </div>
                        <div className="rounded-full bg-[#f8fafc] px-3 py-1 text-xs font-semibold text-[#475569]">{fulfillmentsByLine[line.id]?.length ?? 0} shipment{(fulfillmentsByLine[line.id]?.length ?? 0) === 1 ? "" : "s"}</div>
                      </div>
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        <div>
                          <label className="text-xs font-medium text-[#334155]">Qty to ship</label>
                          <input name="ship_qty" type="number" min="1" max={remainingQty} step="1" defaultValue={remainingQty > 0 ? 1 : 0} className="input mt-1" />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-[#334155]">Tracking</label>
                          <input name="tracking_number" className="input mt-1" placeholder="Enter tracking number" required />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-[#334155]">Carrier</label>
                          <input name="carrier" className="input mt-1" placeholder="Optional" />
                        </div>
                        <div>
                          <label className="text-xs font-medium text-[#334155]">Ship date</label>
                          <input name="shipment_date" type="date" className="input mt-1" required />
                        </div>
                      </div>
                      <div className="mt-3 flex justify-end">
                        <button className="btn-primary" type="submit" disabled={remainingQty <= 0}>Create Shipment</button>
                      </div>
                    </form>
                  );
                })}
              </div>
            </section>
          </div>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm" id="notes">
              <h2 className="text-xl font-semibold text-[#111827]">Notes</h2>
              <p className="mt-1 text-sm text-[#5a5a5a]">Internal order notes stay with the warehouse workflow.</p>
              <form action={addOrderNoteAction} className="mt-4 space-y-3">
                <input type="hidden" name="orderId" value={orderRecord.id} />
                <textarea name="message" rows={4} className="w-full rounded-xl border border-[#d1d5db] p-3 text-sm" placeholder="Add a note..." />
                <div className="flex justify-end">
                  <button className="btn-primary" type="submit">Save Note</button>
                </div>
              </form>
            </section>

            <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-[#111827]">History Timeline</h2>
              <p className="mt-1 text-sm text-[#5a5a5a]">Order and line-level events are captured here in time order.</p>
              <div className="mt-4 space-y-3">
                {activities.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-4 text-sm text-[#6b7280]">No history has been recorded yet.</div>
                ) : activities.slice(0, 8).map((activity) => {
                  const activityLabel = (activity.action ?? "ORDER_EVENT").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
                  return (
                    <div key={activity.id} className="flex items-start gap-3 rounded-xl border border-[#eef2f7] bg-[#fafbfc] p-3 text-sm">
                      <div className="mt-1 h-8 w-8 rounded-full bg-[#eefbf3] text-center text-xs font-bold leading-8 text-[#18794e]">{activity.action?.startsWith("ORDER_LINE") ? "L" : "O"}</div>
                      <div className="flex-1">
                        <p className="font-semibold text-[#111827]">{activityLabel}</p>
                        <p className="mt-1 text-[#5a5a5a]">{activity.details ? JSON.stringify(activity.details) : "No details"}</p>
                      </div>
                      <p className="text-xs text-[#64748b]">{formatDateTime(activity.created_at)}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>

        <aside className="space-y-6">
          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#475569]">Order Actions</h2>
            <div className="mt-4 space-y-2">
              <a href="#notes" className="btn-primary flex w-full justify-center">Add Note</a>
              <a href="#quick-ship" className="btn-secondary flex w-full justify-center">Add Shipment</a>
              <button type="button" className="btn-secondary w-full" disabled>Split Order</button>
              <button type="button" className="btn-secondary w-full" disabled>Cancel Order</button>
            </div>
          </section>

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#475569]">Order Summary</h2>
            <div className="mt-4 space-y-2 text-sm text-[#374151]">
              <div className="flex items-center justify-between gap-3"><span>Line Items</span><span className="font-semibold text-[#111827]">{lineItemCount}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Open Quantity</span><span className="font-semibold text-[#111827]">{openQtyTotal}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Shipped Quantity</span><span className="font-semibold text-[#111827]">{shippedQtyTotal}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Backordered</span><span className="font-semibold text-[#b91c1c]">{openQtyTotal}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Unallocated</span><span className="font-semibold text-[#b91c1c]">{unallocatedLines}</span></div>
              <div className="border-t border-[#eef2f7] pt-2 flex items-center justify-between gap-3"><span>Total</span><span className="font-semibold text-[#111827]">{formatCurrency(quickbooksSnapshot?.total_amount)}</span></div>
            </div>
          </section>

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#475569]">Legacy / Import Info</h2>
            <div className="mt-4 space-y-2 text-sm text-[#374151]">
              <div className="flex items-center justify-between gap-3"><span>Import Source</span><span className="font-semibold text-[#111827]">{orderSourceLabel}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Imported At</span><span className="font-semibold text-[#111827]">{formatDateTime(importTimestamp)}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Legacy Assignment</span><span className="font-semibold text-[#111827]">{orderLines.some((line) => Boolean(line.legacy_container_assignment)) ? "Present" : "None"}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Suggested Assignment</span><span className="font-semibold text-[#111827]">{orderLines.some((line) => line.suggested_assignment_source && line.suggested_assignment_source !== "UNASSIGNED") ? "Present" : "None"}</span></div>
            </div>
          </section>

          {hasOrderAttachmentsTable ? <section className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#475569]">Documents</h2>
            <p className="mt-1 text-sm text-[#5a5a5a]">Order-level files and shipping documents.</p>
            <form action={uploadOrderAttachmentAction} className="mt-4 space-y-3">
              <input type="hidden" name="order_id" value={orderRecord.id} />
              <input type="file" name="attachments" multiple className="block w-full text-sm text-[#374151]" />
              <button className="btn-secondary w-full">Upload</button>
            </form>
            <div className="mt-4 space-y-2">
              {attachmentLinks.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-4 text-center text-xs text-[#6b7280]">Drop files here or click to upload</div>
              ) : attachmentLinks.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((attachment) => (
                <div key={attachment.id} className="rounded-lg border border-[#eef2f7] bg-[#fafbfc] p-3 text-sm">
                  <p className="font-semibold text-[#111827]">{attachment.file_name}</p>
                  <p className="mt-1 text-xs text-[#64748b]">{attachment.mime_type ?? "Attachment"} • {attachment.file_size ? `${Math.round(attachment.file_size / 1024)} KB` : "—"}</p>
                  <div className="mt-2 flex gap-2">
                    {attachment.signedUrl ? <a href={attachment.signedUrl} target="_blank" rel="noreferrer" className="btn-secondary inline-flex text-xs">Open</a> : null}
                    <form action={deleteOrderAttachmentAction}>
                      <input type="hidden" name="order_id" value={orderRecord.id} />
                      <input type="hidden" name="attachment_id" value={attachment.id} />
                      <button className="btn-secondary text-xs">Delete</button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          </section> : null}

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#475569]">QuickBooks Snapshot</h2>
            {quickbooksSnapshot ? (
              <div className="mt-4 space-y-3 text-sm text-[#374151]">
                <div className="flex items-center justify-between gap-3"><span>Invoice</span><span className="font-semibold text-[#111827]">#{quickbooksSnapshot.invoice_number ?? orderRecord.order_number ?? "—"}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Payment</span><span className="font-semibold text-[#111827]">{quickbooksSnapshot.payment_status ?? "Pending"}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Invoice Date</span><span className="font-semibold text-[#111827]">{formatDate(quickbooksSnapshot.invoice_date)}</span></div>
                <div className="border-t border-[#eef2f7] pt-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Invoice Lines</p>
                  <div className="mt-2 space-y-1 text-xs text-[#5a5a5a]">
                    {quickbooksLineItems.length > 0 ? quickbooksLineItems.slice(0, 5).map((line) => <p key={line}>{line}</p>) : <p>No line items found in snapshot.</p>}
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-[#915b12]">QuickBooks invoice data is not linked yet.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
