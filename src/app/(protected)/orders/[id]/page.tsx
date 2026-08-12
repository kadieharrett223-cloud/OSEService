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
    product_id?: string | null;
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
  actor_id?: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

type AccessUserRow = {
  id: string;
  full_name: string | null;
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

type InvoiceItem = {
  key: string;
  sku: string | null;
  description: string;
  orderedQty: number;
  amount: number | null;
  productId: string | null;
  shippingLine: NonNullable<OrderDetailRow["shipping_order_lines"]>[number] | null;
  isNonInventory: boolean;
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

type ProductAliasLookupRow = {
  product_id: string;
  alias: string;
  products?: {
    id: string;
    sku: string | null;
    canonical_name: string | null;
  } | null;
};

type InventoryTransactionLookupRow = {
  product_id: string | null;
  bucket: string | null;
  delta: number | null;
};

type ContainerLineLookupRow = {
  product_id: string | null;
  on_order_qty: number | null;
  container_id: string | null;
  containers?: {
    id: string;
    container_number: string | null;
    lifecycle_status: string | null;
    eta_confirmed_date: string | null;
    eta_estimated_date: string | null;
  } | null;
};

type AllocationLookupRow = {
  product_id: string | null;
  container_id: string | null;
  quantity: number | null;
  source_type: string | null;
  shipping_order_line_id: string | null;
  containers?: {
    id: string;
    container_number: string | null;
    lifecycle_status: string | null;
    eta_confirmed_date: string | null;
    eta_estimated_date: string | null;
  } | null;
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

function normalizeSkuKey(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || null;
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

function parseQuickbooksInvoiceItems(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return [] as Array<{ sku: string | null; description: string; qty: number; amount: number | null; isNonInventory: boolean }>;

  const payload = rawPayload as { Line?: unknown[] };
  const lines = Array.isArray(payload.Line) ? payload.Line : [];

  return lines
    .map((line) => {
      if (!line || typeof line !== "object") return null;

      const item = line as {
        Description?: unknown;
        Qty?: unknown;
        Amount?: unknown;
        SalesItemLineDetail?: {
          Qty?: unknown;
          ItemRef?: { name?: unknown };
        };
      };

      const sku = typeof item.SalesItemLineDetail?.ItemRef?.name === "string" ? item.SalesItemLineDetail.ItemRef.name.trim() : null;
      const description = typeof item.Description === "string" && item.Description.trim()
        ? item.Description.trim()
        : sku ?? "Invoice line";

      const qtyRaw = item.SalesItemLineDetail?.Qty ?? item.Qty ?? 0;
      const qty = Number(qtyRaw);
      const amount = Number(item.Amount ?? 0);
      const isNonInventory = description.trim().startsWith("--") || description.toLowerCase().includes("discount");

      return {
        sku,
        description,
        qty: Number.isFinite(qty) && qty > 0 ? qty : (isNonInventory ? 0 : 1),
        amount: Number.isFinite(amount) ? amount : null,
        isNonInventory,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
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

function deriveItemStatus(item: InvoiceItem) {
  if (item.isNonInventory) return "N/A";
  const line = item.shippingLine;
  if (!line) return "Needs Mapping";
  if ((line.fulfillment_status ?? "") === "FULFILLED") return "Shipped";
  if (["READY_TO_SHIP", "IN_WAREHOUSE", "PICKED", "ON_FLOOR"].includes(line.warehouse_status ?? "")) return "Ready to Ship";
  if ((line.approval_status ?? "") === "HOLD" || (line.warehouse_status ?? "") === "HOLD") return "Hold";
  return "Waiting";
}

function itemStatusClass(label: string) {
  const normalized = label.toUpperCase();
  if (normalized.includes("READY") || normalized.includes("SHIP") || normalized === "PAID") return "bg-[#e7f7ed] text-[#1b7a43]";
  if (normalized.includes("WAIT") || normalized.includes("PENDING")) return "bg-[#fff7e6] text-[#b45309]";
  if (normalized.includes("HOLD")) return "bg-[#fee2e2] text-[#b91c1c]";
  return "bg-[#eef2f7] text-[#334155]";
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
      .select("id, action, actor_id, details, created_at")
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
  const parsedInvoiceItems = parseQuickbooksInvoiceItems(quickbooksSnapshot?.raw_payload);

  const actorIds = Array.from(new Set(activities.map((activity) => activity.actor_id).filter(Boolean))) as string[];
  const { data: actorRows } = actorIds.length
    ? await supabase.from("access_users").select("id, full_name").in("id", actorIds)
    : { data: [] };
  const actorNameById = new Map((actorRows ?? []).map((row) => [row.id, row.full_name ?? "Unknown user"])) as Map<string, string>;

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
  const orderNotes = activities.filter((activity) => activity.action === "ORDER_NOTE_ADDED");

  const allProductRows = parsedInvoiceItems.length > 0
    ? Array.from(new Set(parsedInvoiceItems.map((item) => item.sku).filter(Boolean)))
    : [];

  const { data: productRows } = allProductRows.length
    ? await supabase.from("products").select("id, sku, canonical_name").in("sku", allProductRows as string[])
    : { data: [] };

  const productMap = new Map<string, { id: string; sku: string | null; canonical_name: string | null }>();
  for (const product of productRows ?? []) {
    const skuKey = normalizeSkuKey(product.sku);
    if (skuKey) productMap.set(skuKey, product);
  }

  const { data: aliasRows } = allProductRows.length
    ? await supabase.from("product_aliases").select("product_id, alias, products (id, sku, canonical_name)")
    : { data: [] };

  for (const alias of (aliasRows ?? []) as ProductAliasLookupRow[]) {
    const aliasKey = normalizeSkuKey(alias.alias);
    const product = alias.products as { id: string; sku: string | null; canonical_name: string | null } | null;
    if (aliasKey && product) {
      productMap.set(aliasKey, product);
    }
  }

  const resolvedProductIds = Array.from(new Set(parsedInvoiceItems.map((item) => {
    const direct = item.sku ? productMap.get(normalizeSkuKey(item.sku) ?? "") : null;
    return direct?.id ?? null;
  }).filter(Boolean))) as string[];

  const { data: onFloorRows } = resolvedProductIds.length
    ? await supabase
        .from("inventory_transactions")
        .select("product_id, bucket, delta")
        .in("product_id", resolvedProductIds)
        .eq("bucket", "ON_FLOOR")
    : { data: [] };

  const { data: containerLineRows } = resolvedProductIds.length
    ? await supabase
        .from("container_lines")
        .select("product_id, on_order_qty, container_id, containers (id, container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date)")
        .in("product_id", resolvedProductIds)
    : { data: [] };

  const { data: allAllocRows } = resolvedProductIds.length
    ? await supabase
        .from("inventory_allocations")
        .select("product_id, container_id, quantity, source_type, shipping_order_line_id, containers (id, container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date)")
        .in("product_id", resolvedProductIds)
    : { data: [] };

  const onFloorAvailableByProduct = new Map<string, number>();
  for (const row of (onFloorRows ?? []) as InventoryTransactionLookupRow[]) {
    const productId = row.product_id ?? null;
    if (!productId) continue;
    onFloorAvailableByProduct.set(productId, (onFloorAvailableByProduct.get(productId) ?? 0) + Number(row.delta ?? 0));
  }

  const floorCommittedByProduct = new Map<string, number>();
  const containerCommittedByKey = new Map<string, number>();
  for (const row of (allAllocRows ?? []) as AllocationLookupRow[]) {
    const productId = row.product_id ?? null;
    if (!productId) continue;
    const qty = Number(row.quantity ?? 0);
    if (row.source_type === "FLOOR") {
      floorCommittedByProduct.set(productId, (floorCommittedByProduct.get(productId) ?? 0) + qty);
    }
    if (row.source_type === "CONTAINER" && row.container_id) {
      const key = `${productId}:${row.container_id}`;
      containerCommittedByKey.set(key, (containerCommittedByKey.get(key) ?? 0) + qty);
    }
  }

  const shippingLineBySkuKey = new Map<string, NonNullable<OrderDetailRow["shipping_order_lines"]>[number]>();
  for (const line of orderLines) {
    const keys = [
      normalizeSkuKey(line.products?.sku),
      normalizeSkuKey(line.legacy_container_assignment),
    ].filter(Boolean) as string[];
    if ((line as { legacy_item_code?: string | null }).legacy_item_code) {
      keys.push(normalizeSkuKey((line as { legacy_item_code?: string | null }).legacy_item_code) as string);
    }
    for (const key of keys) {
      if (key && !shippingLineBySkuKey.has(key)) shippingLineBySkuKey.set(key, line);
    }
  }

  const visibleItems: InvoiceItem[] = (parsedInvoiceItems.length > 0 ? parsedInvoiceItems : orderLines.map((line) => ({
    sku: line.products?.sku ?? null,
    description: line.products?.canonical_name ?? line.products?.sku ?? "Line item",
    qty: Number(line.ordered_qty ?? 0),
    amount: null,
    isNonInventory: false,
  }))).map((item, index) => {
    const skuKey = normalizeSkuKey(item.sku);
    const shippingLine = skuKey ? shippingLineBySkuKey.get(skuKey) ?? null : orderLines[index] ?? null;
    const resolvedProduct = skuKey ? productMap.get(skuKey) ?? null : null;
    return {
      key: `${skuKey ?? "line"}-${index}`,
      sku: item.sku,
      description: item.description,
      orderedQty: item.qty,
      amount: item.amount,
      productId: shippingLine?.product_id ?? resolvedProduct?.id ?? null,
      shippingLine,
      isNonInventory: item.isNonInventory,
    };
  });

  const visibleLineCount = visibleItems.length;
  const visibleOrderedTotal = visibleItems.reduce((sum, item) => sum + item.orderedQty, 0);
  const visibleOpenTotal = visibleItems.reduce((sum, item) => {
    if (item.shippingLine) return sum + Math.max(0, Number(item.shippingLine.approved_qty ?? 0) - Number(item.shippingLine.fulfilled_qty ?? 0));
    return sum + Math.max(0, item.orderedQty);
  }, 0);
  const visibleShippedTotal = visibleItems.reduce((sum, item) => sum + Number(item.shippingLine?.fulfilled_qty ?? 0), 0);
  const visibleAllocatedCount = visibleItems.filter((item) => (item.shippingLine?.inventory_allocations?.length ?? 0) > 0).length;
  const visibleUnallocatedCount = visibleItems.filter((item) => !item.isNonInventory && (item.shippingLine?.inventory_allocations?.length ?? 0) === 0).length;

  function getSuggestedInventory(item: InvoiceItem) {
    if (item.isNonInventory) {
      return { label: "N/A", eta: "No inventory required", detail: "N/A" };
    }

    const line = item.shippingLine;
    if (line && (line.inventory_allocations?.length ?? 0) > 0) {
      const allocation = line.inventory_allocations?.[0];
      if (allocation?.source_type === "FLOOR") {
        return { label: "On Floor", eta: "Available now", detail: "Ready" };
      }
      if (allocation?.source_type === "CONTAINER") {
        return {
          label: allocation.containers?.container_number ?? "Container",
          eta: formatDate(allocation.containers?.eta_confirmed_date ?? allocation.containers?.eta_estimated_date),
          detail: `${Number(allocation.quantity ?? 0)} assigned`,
        };
      }
    }

    const productId = item.productId;
    if (!productId) {
      return { label: "Needs mapping", eta: "Unavailable", detail: "Map SKU to manage inventory" };
    }

    const floorAvailable = (onFloorAvailableByProduct.get(productId) ?? 0) - (floorCommittedByProduct.get(productId) ?? 0);
    if (floorAvailable > 0) {
      return { label: "On Floor", eta: "Available now", detail: "Ready" };
    }

    const candidateContainer = ((containerLineRows ?? []) as ContainerLineLookupRow[])
      .filter((row) => row.product_id === productId && row.containers && ["ORDERED", "PRODUCTION", "INBOUND"].includes(String(row.containers.lifecycle_status ?? "").toUpperCase()))
      .map((row) => {
        const committed = row.container_id ? (containerCommittedByKey.get(`${productId}:${row.container_id}`) ?? 0) : 0;
        const available = Number(row.on_order_qty ?? 0) - committed;
        return {
          container: row.containers,
          available,
        };
      })
      .filter((row) => row.available > 0)
      .sort((left, right) => {
        const leftDate = new Date(left.container?.eta_confirmed_date ?? left.container?.eta_estimated_date ?? "9999-12-31").getTime();
        const rightDate = new Date(right.container?.eta_confirmed_date ?? right.container?.eta_estimated_date ?? "9999-12-31").getTime();
        return leftDate - rightDate;
      })[0];

    if (candidateContainer?.container) {
      return {
        label: candidateContainer.container.container_number ?? "Container",
        eta: formatDate(candidateContainer.container.eta_confirmed_date ?? candidateContainer.container.eta_estimated_date),
        detail: `${candidateContainer.available} available`,
      };
    }

    return { label: "Waiting", eta: "No source available", detail: "Unassigned" };
  }

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
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold text-[#111827]">{orderRecord.customers?.company_name ?? orderRecord.customers?.full_name ?? orderRecord.legacy_customer_name ?? "Customer pending"} — Invoice #{quickbooksSnapshot?.invoice_number ?? orderRecord.order_number ?? "—"}</h1>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${metricStatusClass(orderRecord.review_status)}`}>{orderRecord.review_status ?? "APPROVED"}</span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${metricStatusClass(quickbooksSnapshot?.payment_status)}`}>{quickbooksSnapshot?.payment_status ?? "Pending"}</span>
            </div>
            <p className="mt-3 text-sm text-[#5a5a5a]">{orderRecord.customers?.phone ?? "No phone"} · {orderRecord.customers?.email ?? "No email"} · {quickbooksSnapshot?.shipping_address ?? "Shipping address unavailable"} · Salesperson {salesperson ?? "—"} · Priority {orderLines.some((line) => line.priority === "HIGH" || line.priority === "CRITICAL") ? "HIGH" : orderLines[0]?.priority ?? "NORMAL"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {shippingOrderColumnSet.has("promised_ship_date") || shippingOrderColumnSet.has("shipping_method") || shippingOrderColumnSet.has("notes") ? (
              <details className="group rounded-xl border border-[#e5e7eb] bg-white p-3 shadow-sm">
                <summary className="cursor-pointer list-none text-sm font-semibold text-[#334155]">Edit Order</summary>
                <form action={updateOrderScheduleAction} className="mt-3 grid min-w-[280px] gap-3">
                  <input type="hidden" name="orderId" value={orderRecord.id} />
                  {shippingOrderColumnSet.has("promised_ship_date") ? <input type="date" name="schedule_date" defaultValue={orderRecord.promised_ship_date ?? ""} className="input" /> : null}
                  {shippingOrderColumnSet.has("shipping_method") ? <input name="shipping_method" defaultValue={orderRecord.shipping_method ?? ""} className="input" placeholder="Shipping method" /> : null}
                  {shippingOrderColumnSet.has("notes") ? <textarea name="schedule_notes" rows={3} defaultValue={orderRecord.notes ?? ""} className="textarea" placeholder="Operational fields" /> : null}
                  <button className="btn-secondary" type="submit">Save Order</button>
                </form>
              </details>
            ) : null}
            <Link href="/orders" className="btn-secondary inline-flex">Back to orders</Link>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2 text-sm font-semibold text-[#475569]">
          <span className="rounded-full bg-[#fff1f2] px-3 py-2 text-[#d50917]">Overview</span>
          <span className="rounded-full bg-[#f8fafc] px-3 py-2">Line Items ({visibleLineCount})</span>
          <span className="rounded-full bg-[#f8fafc] px-3 py-2">Allocations ({visibleAllocatedCount})</span>
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
                <h2 className="text-xl font-semibold text-[#111827]">Items & Fulfillment</h2>
                <p className="mt-1 text-sm text-[#5a5a5a]">Open the order and immediately see what was ordered, where each item is coming from, when it will be available, and what still needs action.</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-semibold text-[#475569]">
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">Ordered {visibleOrderedTotal}</span>
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">Open {visibleOpenTotal}</span>
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">Shipped {visibleShippedTotal}</span>
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">Backordered {visibleOpenTotal}</span>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <div className="min-w-[980px]">
                <thead>
                  <tr className="border-b border-[#edf2f7] text-xs uppercase tracking-[0.08em] text-[#64748b]">
                    <th className="px-2 py-3">#</th>
                    <th className="px-2 py-3">SKU</th>
                    <th className="px-2 py-3">Description</th>
                    <th className="px-2 py-3">Qty</th>
                    <th className="px-2 py-3">Inventory Source</th>
                    <th className="px-2 py-3">ETA / Availability</th>
                    <th className="px-2 py-3">Status</th>
                    <th className="px-2 py-3">Shipped</th>
                    <th className="px-2 py-3">Actions</th>
                  </tr>
                </thead>
                <div>
                  {visibleItems.map((item, index) => {
                    const line = item.shippingLine;
                    const remainingQty = line ? Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)) : Math.max(0, item.orderedQty);
                    const allocationSummary = line ? summarizeAllocation(line) : (item.isNonInventory ? { label: "N/A", detail: "N/A" } : { label: "UNALLOCATED", detail: "—" });
                    const suggestedInventory = getSuggestedInventory(item);
                    const lineHistoryCount = line ? (lineHistoryById[line.id]?.length ?? 0) : 0;
                    const itemStatus = deriveItemStatus(item);
                    return (
                      <details key={item.key} className="border-b border-[#f1f5f9] group">
                        <summary className="grid cursor-pointer grid-cols-[40px_90px_minmax(240px,1.5fr)_80px_170px_150px_120px_90px_120px] items-start gap-3 px-2 py-4 text-sm text-[#1f2937] list-none">
                          <span className="font-semibold">{index + 1}</span>
                          <span className="font-semibold text-[#111827]">{item.sku ?? "—"}</span>
                          <span>
                            <span className="font-medium text-[#111827]">{item.description}</span>
                            <span className="mt-1 block text-xs text-[#64748b]">{line ? `Warehouse ${formatStatus(line.warehouse_status)} · Fulfillment ${formatStatus(line.fulfillment_status)}` : item.isNonInventory ? "Non-inventory charge" : "Not yet imported into warehouse workflow"}</span>
                          </span>
                          <span>{item.orderedQty}</span>
                          <span>
                            <span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ${allocationSummary.label === "UNALLOCATED" ? "bg-[#fff1f2] text-[#b91c1c]" : allocationSummary.label === "N/A" ? "bg-[#eef2f7] text-[#64748b]" : "bg-[#eefbf3] text-[#18794e]"}`}>{allocationSummary.label === "UNALLOCATED" ? suggestedInventory.label : allocationSummary.detail.split(" · ")[0] || allocationSummary.label}</span>
                            <span className="mt-1 block text-xs text-[#64748b]">{allocationSummary.label === "UNALLOCATED" ? suggestedInventory.detail : allocationSummary.detail}</span>
                          </span>
                          <span className="text-xs text-[#475569]">{suggestedInventory.eta}</span>
                          <span><span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ${itemStatusClass(itemStatus)}`}>{itemStatus}</span></span>
                          <span>{Number(line?.fulfilled_qty ?? 0)}</span>
                          <span>
                            {line ? <span className="inline-flex rounded-lg border border-[#d9e2f7] bg-white px-3 py-2 text-xs font-semibold text-[#334155]">Manage</span> : <span className="inline-flex rounded-lg border border-[#f1d3a4] bg-[#fff8ec] px-3 py-2 text-xs font-semibold text-[#915b12]">{item.isNonInventory ? "N/A" : "Map SKU"}</span>}
                          </span>
                        </summary>
                        {line ? <div className="grid gap-4 border-t border-[#eef2f7] bg-[#fafbfc] px-4 py-4 xl:grid-cols-3">
                          <div className="rounded-xl border border-[#e5e7eb] bg-white p-4">
                            <h3 className="text-sm font-semibold text-[#111827]">Inventory</h3>
                            <div className="mt-3 space-y-2 text-sm text-[#374151]">
                              <div><span className="font-medium text-[#64748b]">Assigned source:</span> {allocationSummary.label === "UNALLOCATED" ? "Unassigned" : allocationSummary.detail}</div>
                              <div><span className="font-medium text-[#64748b]">ETA:</span> {suggestedInventory.eta}</div>
                              <div><span className="font-medium text-[#64748b]">Qty assigned:</span> {line.inventory_allocations?.reduce((sum, allocation) => sum + Number(allocation.quantity ?? 0), 0) ?? 0}</div>
                            </div>
                            <form action={updateOrderLineAssignmentAction} className="mt-4 grid gap-2">
                              <input type="hidden" name="orderId" value={orderRecord.id} />
                              <input type="hidden" name="lineId" value={line.id} />
                              <select name="assignment_source" className="select text-sm" defaultValue={line.inventory_allocations?.[0]?.source_type ?? line.suggested_assignment_source ?? "UNASSIGNED"}>
                                <option value="UNASSIGNED">Unassigned</option>
                                <option value="FLOOR">On Floor</option>
                                <option value="CONTAINER">Container</option>
                              </select>
                              <select name="container_id" className="select text-sm" defaultValue={line.inventory_allocations?.[0]?.container_id ?? line.suggested_container_id ?? ""}>
                                <option value="">Select container</option>
                                {containerOptions.map((container) => (
                                  <option key={container.id} value={container.id}>
                                    {(container.container_number ?? "Container")} · {formatStatus(container.lifecycle_status)} · ETA {formatDate(container.eta_confirmed_date ?? container.eta_estimated_date)}
                                  </option>
                                ))}
                              </select>
                              <button className="btn-secondary" type="submit">Change Assignment</button>
                            </form>
                          </div>

                          <div className="rounded-xl border border-[#e5e7eb] bg-white p-4">
                            <h3 className="text-sm font-semibold text-[#111827]">Shipment</h3>
                            <div className="mt-3 space-y-2 text-sm text-[#374151]">
                              {(fulfillmentsByLine[line.id] ?? []).length === 0 ? <p className="text-[#64748b]">No shipments yet.</p> : (fulfillmentsByLine[line.id] ?? []).map((shipment) => (
                                <div key={shipment.id} className="rounded-lg border border-[#eef2f7] bg-[#fafbfc] p-2 text-xs">
                                  <p>{formatDateTime(shipment.fulfilled_at)} · Qty {shipment.fulfilled_qty ?? 0}</p>
                                  <p>{shipment.carrier ?? "Carrier pending"} · {shipment.tracking_number ?? "Tracking pending"}</p>
                                </div>
                              ))}
                            </div>
                            <form action={markOrderLineShippedAction} className="mt-4 grid gap-2">
                              <input type="hidden" name="orderId" value={orderRecord.id} />
                              <input type="hidden" name="lineId" value={line.id} />
                              <input name="ship_qty" type="number" min="1" max={remainingQty} step="1" defaultValue={remainingQty > 0 ? 1 : 0} className="input" />
                              <input name="tracking_number" className="input" placeholder="Tracking #" required />
                              <input name="carrier" className="input" placeholder="Carrier" />
                              <input name="shipment_date" type="date" className="input" required />
                              <button className="btn-primary" type="submit" disabled={remainingQty <= 0}>Mark Shipped</button>
                            </form>
                          </div>

                          <div className="rounded-xl border border-[#e5e7eb] bg-white p-4">
                            <h3 className="text-sm font-semibold text-[#111827]">Item Note</h3>
                            <form action={addOrderNoteAction} className="mt-4 grid gap-2">
                              <input type="hidden" name="orderId" value={orderRecord.id} />
                              <input type="hidden" name="lineId" value={line.id} />
                              <input type="hidden" name="sku" value={item.sku ?? ""} />
                              <textarea name="message" rows={4} className="textarea" placeholder="Add an item-specific note" />
                              <button className="btn-secondary" type="submit">Save Note</button>
                            </form>
                            <p className="mt-3 text-xs text-[#64748b]">History events {lineHistoryCount}</p>
                          </div>
                        </div> : null}
                      </details>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <div className="grid gap-6 xl:grid-cols-2">
            <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm" id="notes">
              <h2 className="text-xl font-semibold text-[#111827]">Order Notes</h2>
              <p className="mt-1 text-sm text-[#5a5a5a]">Notes record exceptions and customer-specific fulfillment instructions without repeating item data above.</p>
              <form action={addOrderNoteAction} className="mt-4 space-y-3">
                <input type="hidden" name="orderId" value={orderRecord.id} />
                <textarea name="message" rows={4} className="w-full rounded-xl border border-[#d1d5db] p-3 text-sm" placeholder="Add a note..." />
                <div className="flex justify-end">
                  <button className="btn-primary" type="submit">Save Note</button>
                </div>
              </form>
              <div className="mt-4 space-y-3">
                {orderNotes.length === 0 ? <p className="text-sm text-[#6b7280]">No order notes yet.</p> : orderNotes.map((activity) => (
                  <div key={activity.id} className="rounded-lg border border-[#eef2f7] bg-[#fafbfc] p-3 text-sm">
                    <p className="font-semibold text-[#111827]">{formatDateTime(activity.created_at)} — {activity.actor_id ? actorNameById.get(activity.actor_id) ?? "System" : "System"}</p>
                    <p className="mt-1 text-[#5a5a5a]">{typeof activity.details?.message === "string" ? activity.details.message : "Note saved"}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-[#111827]">Activity Timeline</h2>
              <p className="mt-1 text-sm text-[#5a5a5a]">Compact fulfillment history across imports, assignments, receipts, and shipments.</p>
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
                        <p className="mt-1 text-xs text-[#64748b]">{activity.actor_id ? actorNameById.get(activity.actor_id) ?? "System" : "System"}</p>
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
              <button type="button" className="btn-secondary w-full" disabled>Add Shipment</button>
              <button type="button" className="btn-secondary w-full" disabled>Split Order</button>
              <button type="button" className="btn-secondary w-full" disabled>Cancel Order</button>
            </div>
          </section>

          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-[#475569]">Order Summary</h2>
            <div className="mt-4 space-y-2 text-sm text-[#374151]">
              <div className="flex items-center justify-between gap-3"><span>Line Items</span><span className="font-semibold text-[#111827]">{visibleLineCount}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Open Quantity</span><span className="font-semibold text-[#111827]">{visibleOpenTotal}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Shipped Quantity</span><span className="font-semibold text-[#111827]">{visibleShippedTotal}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Backordered</span><span className="font-semibold text-[#b91c1c]">{visibleOpenTotal}</span></div>
              <div className="flex items-center justify-between gap-3"><span>Unallocated</span><span className="font-semibold text-[#b91c1c]">{visibleUnallocatedCount}</span></div>
              <div className="border-t border-[#eef2f7] pt-2 flex items-center justify-between gap-3"><span>Total</span><span className="font-semibold text-[#111827]">{formatCurrency(quickbooksSnapshot?.total_amount)}</span></div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
