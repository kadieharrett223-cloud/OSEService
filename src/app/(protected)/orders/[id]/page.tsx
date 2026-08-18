import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getSuggestedAllocation,
  type OpenQueueLine,
  type ProductContainerSupply,
} from "@/lib/fulfillment/suggested-allocation";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  addOrderNoteAction,
  deleteOrderAttachmentAction,
  markOrderLinesPickedUpAction,
  markOrderLineShippedAction,
  moveOrderLineBackToOrdersAction,
  updateOrderLineAssignmentAction,
  updateOrderLineStatusAction,
  updateOrderScheduleAction,
  updateOrderOperationsAction,
  overrideProductQueuePositionAction,
  uploadOrderAttachmentAction,
} from "../actions";
import { AttachmentDropzone } from "@/app/(protected)/cases/new/attachment-dropzone";
import { ShipItemsForm } from "./ship-items-form";

type OrderDetailRow = {
  id: string;
  order_number: string | null;
  source_invoice_id: string | null;
  legacy_customer_name: string | null;
  review_status: string | null;
  promised_ship_date: string | null;
  shipping_method: string | null;
  fulfillment_method?: "SHIP" | "WILL_CALL" | null;
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
    queue_position_count: number | null;
    queue_position_override: number | null;
    queue_position_override_reason: string | null;
    legacy_item_code: string | null;
    legacy_matched_item_code: string | null;
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
  entered_date: string | null;
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
  document_type?: string | null;
  note?: string | null;
  is_restricted?: boolean | null;
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
  fulfillment_type?: "SHIPMENT" | "PICKUP" | null;
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

type ItemSupplySnapshot = {
  comingFrom: string;
  availability: string;
  fulfillment: string;
  action: string;
  suggestion: ReturnType<typeof getSuggestedAllocation> | null;
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
    entered_date: string | null;
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
  allocation_status: string | null;
  shipping_order_line_id: string | null;
  containers?: {
    id: string;
    container_number: string | null;
    entered_date: string | null;
    lifecycle_status: string | null;
    eta_confirmed_date: string | null;
    eta_estimated_date: string | null;
  } | null;
};

type OpenQueueLineLookupRow = {
  id: string;
  product_id: string | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  priority: string | null;
  queue_position_start: number | null;
  approved_at: string | null;
  created_at: string;
  inventory_allocations?: Array<{
    id: string;
    allocation_status: string | null;
  }>;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function highestPriority(values: Array<string | null | undefined>) {
  const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
  return values
    .map((value) => String(value ?? "NORMAL").toUpperCase())
    .sort((left, right) => (rank[left] ?? 2) - (rank[right] ?? 2))[0] ?? "NORMAL";
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

function truncateText(value: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1)}…`;
}

function cleanAddressForHeader(address: string | null | undefined, phone: string | null | undefined, email: string | null | undefined) {
  if (!address) return "Shipping address unavailable";

  const normalizedPhone = String(phone ?? "").replace(/\D/g, "");
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  const seen = new Set<string>();

  const chunks = address
    .split(/\r?\n|,/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .filter((chunk) => {
      const lower = chunk.toLowerCase();
      if (lower.startsWith("phone:")) return false;
      if (lower.startsWith("email:")) return false;
      if (normalizedEmail && lower.includes(normalizedEmail)) return false;

      const digits = chunk.replace(/\D/g, "");
      if (normalizedPhone.length >= 7 && digits.length >= 7 && digits.includes(normalizedPhone.slice(-7))) {
        return false;
      }

      return true;
    });

  const deduped = chunks.filter((chunk) => {
    const key = chunk.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.join(", ") || "Shipping address unavailable";
}

function normalizeSkuKey(value: string | null | undefined) {
  const normalized = String(value ?? "").trim().replace(/\s*\(deleted\)\s*$/i, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
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
        DetailType?: unknown;
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
        DetailType?: unknown;
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
        DetailType?: unknown;
        Description?: unknown;
        Qty?: unknown;
        Amount?: unknown;
        SalesItemLineDetail?: {
          Qty?: unknown;
          ItemRef?: { name?: unknown };
        };
      };

      const sku = typeof item.SalesItemLineDetail?.ItemRef?.name === "string" ? item.SalesItemLineDetail.ItemRef.name.trim() : null;
      const rawDescription = typeof item.Description === "string" ? item.Description.trim() : "";
      const detailType = typeof item.DetailType === "string" ? item.DetailType : "";
      if (!sku && !rawDescription && detailType !== "SalesItemLineDetail") return null;
      const description = rawDescription || sku || "Invoice line";

      const qtyRaw = item.SalesItemLineDetail?.Qty ?? item.Qty ?? 0;
      const qty = Number(qtyRaw);
      const amount = Number(item.Amount ?? 0);
      const normalizedDescription = description.trim().toLowerCase();
      const isNonInventory = detailType !== "SalesItemLineDetail"
        || normalizedDescription.startsWith("--")
        || /discount|shipping|freight|misc(?:ellaneous)?\s+(?:charge|service)|sales tax|tax adjustment|^note$|\bservice\b/.test(normalizedDescription);

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
  const results = await Promise.all(candidates.map(async (column) => ({
    column,
    error: (await supabase.from(tableName).select(column).limit(1)).error,
  })));
  return new Set(results.filter((result) => !result.error).map((result) => result.column));
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
  if (columnSet.has("fulfillment_method")) columns.push("fulfillment_method");

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
      queue_position_count,
      queue_position_override,
      queue_position_override_reason,
      legacy_item_code,
      legacy_matched_item_code,
      legacy_container_assignment,
      suggested_assignment_source,
      suggested_container_id,
      products (sku, canonical_name),
      inventory_allocations (
        quantity,
        source_type,
        allocation_status,
        container_id,
        containers (id, container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date)
      )
    )`,
  );

  return columns.join(",\n        ");
}

function buildActivityDedupKey(activity: OrderActivityEntry) {
  const details = activity.details ?? {};
  const stableDetails = {
    line_id: typeof details.line_id === "string" ? details.line_id : null,
    message: typeof details.message === "string" ? details.message : null,
    source: typeof details.source === "string" ? details.source : null,
    container_id: typeof details.container_id === "string" ? details.container_id : null,
    ship_qty: typeof details.ship_qty === "number" ? details.ship_qty : null,
    tracking_number: typeof details.tracking_number === "string" ? details.tracking_number : null,
    shipment_date: typeof details.shipment_date === "string" ? details.shipment_date : null,
  };

  return `${activity.action ?? "ORDER_EVENT"}|${JSON.stringify(stableDetails)}`;
}

function describeActivityEvent(
  activity: OrderActivityEntry,
  lineSkuById: Map<string, string>,
  containerNumberById: Map<string, string>,
) {
  const details = activity.details ?? {};
  const lineId = typeof details.line_id === "string" ? details.line_id : null;
  const sku = lineId ? lineSkuById.get(lineId) ?? "Item" : "Order";
  const source = typeof details.source === "string" ? details.source.toUpperCase() : null;
  const containerId = typeof details.container_id === "string" ? details.container_id : null;
  const containerNumber = containerId ? containerNumberById.get(containerId) ?? "Container" : null;
  const shipQty = typeof details.ship_qty === "number" ? details.ship_qty : null;

  switch (activity.action) {
    case "ORDER_IMPORTED":
      return "Order imported from backlog";
    case "ORDER_NOTE_ADDED":
      return `${lineId ? `${sku} note added` : "Order note added"}`;
    case "ORDER_SCHEDULE_UPDATED":
      return "Order schedule updated";
    case "ORDER_LINE_ASSIGNMENT_UPDATED":
      if (source === "FLOOR") return `${sku} moved to warehouse`;
      if (source === "CONTAINER") return `${sku} assigned to ${containerNumber ?? "container"}`;
      return `${sku} marked unassigned`;
    case "ORDER_LINE_SHIPPED":
      return `${sku} shipped${shipQty ? ` (Qty ${shipQty})` : ""}`;
    case "ORDER_LINE_APPROVED":
      return `${sku} approved`;
    case "ORDER_LINE_QUEUED":
      return `${sku} moved to queue`;
    case "ORDER_LINE_HOLD":
      return `${sku} put on hold`;
    case "ORDER_LINE_FULFILLED":
      return `${sku} marked fulfilled`;
    case "ORDER_ATTACHMENT_UPLOADED":
      return "Order attachment uploaded";
    case "ORDER_ATTACHMENT_DELETED":
      return "Order attachment deleted";
    default:
      return (activity.action ?? "ORDER_EVENT")
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const user = await requireUser();
  const supabase = getSupabaseAdmin();
  const { id } = await params;
  const { error, message } = await searchParams;

  const shippingOrderColumnSet = await loadTableColumnSet(supabase, "shipping_orders", [
    "promised_ship_date",
    "shipping_method",
    "notes",
    "tracking_number",
    "carrier",
    "fulfillment_method",
  ]);
  const attachmentColumns = await loadTableColumnSet(supabase, "order_attachments", ["id", "document_type", "note", "is_restricted"]);
  const fulfillmentColumns = await loadTableColumnSet(supabase, "fulfillments", ["fulfillment_type"]);
  const hasOrderAttachmentsTable = attachmentColumns.has("id");
  const shippingOrderSelect = buildShippingOrderSelect(shippingOrderColumnSet);
  const attachmentSelect = ["id", "file_name", "file_path", "file_size", "mime_type", "created_at", ...["document_type", "note", "is_restricted"].filter((column) => attachmentColumns.has(column))].join(", ");
  const fulfillmentSelect = ["id", "shipping_order_line_id", "fulfilled_qty", "fulfilled_at", "shipment_number", "carrier", "tracking_number", "reason", ...(fulfillmentColumns.has("fulfillment_type") ? ["fulfillment_type"] : [])].join(", ");

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
          .select(attachmentSelect)
          .eq("shipping_order_id", id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as OrderAttachmentEntry[] }),
    supabase
      .from("containers")
      .select("id, container_number, lifecycle_status, entered_date, eta_confirmed_date, eta_estimated_date")
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
        .select(fulfillmentSelect)
        .in("shipping_order_line_id", lineIds)
        .order("fulfilled_at", { ascending: false })
    : { data: [] };

  const fulfillments = (fulfillmentRows ?? []) as unknown as FulfillmentEntry[];
  const fulfillmentsByLine = fulfillments.reduce<Record<string, FulfillmentEntry[]>>((acc, fulfillment) => {
    if (!acc[fulfillment.shipping_order_line_id]) {
      acc[fulfillment.shipping_order_line_id] = [];
    }
    acc[fulfillment.shipping_order_line_id].push(fulfillment);
    return acc;
  }, {});

  const noteCount = activities.filter((activity) => activity.action === "ORDER_NOTE_ADDED").length;

  const lineHistoryById = activities.reduce<Record<string, OrderActivityEntry[]>>((acc, activity) => {
    const lineId = typeof activity.details?.line_id === "string" ? activity.details.line_id : null;
    if (!lineId) return acc;
    if (!acc[lineId]) {
      acc[lineId] = [];
    }
    acc[lineId].push(activity);
    return acc;
  }, {});

  const orderNotes = activities.filter((activity) => activity.action === "ORDER_NOTE_ADDED");

  const [{ data: productRows }, { data: aliasRows }] = await Promise.all([
    supabase
      .from("products")
      .select("id, sku, canonical_name"),
    supabase
      .from("product_aliases")
      .select("product_id, alias, products (id, sku, canonical_name)"),
  ]);

  const productMap = new Map<string, { id: string; sku: string | null; canonical_name: string | null }>();
  for (const product of productRows ?? []) {
    const skuKey = normalizeSkuKey(product.sku);
    if (skuKey) productMap.set(skuKey, product);
  }

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

  const [{ data: onFloorRows }, { data: containerLineRows }, { data: allAllocRows }, { data: openQueueRows }] = resolvedProductIds.length
    ? await Promise.all([
        supabase
          .from("inventory_transactions")
          .select("product_id, bucket, delta")
          .in("product_id", resolvedProductIds)
          .eq("bucket", "ON_FLOOR"),
        supabase
          .from("container_lines")
          .select("product_id, on_order_qty, container_id, containers (id, container_number, entered_date, lifecycle_status, eta_confirmed_date, eta_estimated_date)")
          .in("product_id", resolvedProductIds),
        supabase
          .from("inventory_allocations")
          .select("product_id, container_id, quantity, source_type, allocation_status, shipping_order_line_id, containers (id, container_number, entered_date, lifecycle_status, eta_confirmed_date, eta_estimated_date)")
          .in("product_id", resolvedProductIds),
        supabase
          .from("shipping_order_lines")
          .select("id, product_id, approved_qty, fulfilled_qty, priority, queue_position_start, approved_at, created_at, inventory_allocations (id, allocation_status)")
          .in("product_id", resolvedProductIds)
          .eq("approval_status", "APPROVED")
          .neq("fulfillment_status", "FULFILLED"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }];
  const onFloorAvailableByProduct = new Map<string, number>();
  for (const row of (onFloorRows ?? []) as InventoryTransactionLookupRow[]) {
    const productId = row.product_id ?? null;
    if (!productId) continue;
    onFloorAvailableByProduct.set(productId, (onFloorAvailableByProduct.get(productId) ?? 0) + Number(row.delta ?? 0));
  }

  const floorCommittedByProduct = new Map<string, number>();
  const containerCommittedByKey = new Map<string, number>();
  for (const row of (allAllocRows ?? []) as AllocationLookupRow[]) {
    if (row.allocation_status && row.allocation_status !== "ALLOCATED") continue;
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

  const floorAvailableByProduct = new Map<string, number>();
  for (const [productId, floorTotal] of onFloorAvailableByProduct.entries()) {
    floorAvailableByProduct.set(productId, Math.max(0, floorTotal - (floorCommittedByProduct.get(productId) ?? 0)));
  }

  const activeContainerStatus = new Set(["ORDERED", "PRODUCTION", "INBOUND"]);
  const containerSupplyByProduct = new Map<string, ProductContainerSupply[]>();
  const containerSupplyByProductContainer = new Map<string, ProductContainerSupply>();
  for (const row of (containerLineRows ?? []) as ContainerLineLookupRow[]) {
    const productId = row.product_id ?? null;
    const containerId = row.container_id;
    const container = row.containers;
    if (!productId || !containerId || !container) continue;

    const lifecycle = String(container.lifecycle_status ?? "").toUpperCase();
    if (!activeContainerStatus.has(lifecycle)) continue;

    const key = `${productId}:${containerId}`;
    const rawQty = Math.max(0, Number(row.on_order_qty ?? 0));
    const previous = containerSupplyByProductContainer.get(key);
    if (previous) {
      previous.available_qty += rawQty;
    } else {
      containerSupplyByProductContainer.set(key, {
        container_id: containerId,
        container_number: container.container_number,
        available_qty: rawQty,
        entered_date: container.entered_date,
        eta_confirmed_date: container.eta_confirmed_date,
        eta_estimated_date: container.eta_estimated_date,
      });
    }
  }

  for (const [key, supply] of containerSupplyByProductContainer.entries()) {
    const [productId] = key.split(":");
    const availableQty = Math.max(0, supply.available_qty - (containerCommittedByKey.get(key) ?? 0));
    if (availableQty <= 0) continue;
    const existingRows = containerSupplyByProduct.get(productId) ?? [];
    existingRows.push({
      ...supply,
      available_qty: availableQty,
    });
    containerSupplyByProduct.set(productId, existingRows);
  }

  const queueLinesByProduct = new Map<string, OpenQueueLine[]>();
  const queueLineById = new Map<string, OpenQueueLine>();
  for (const row of (openQueueRows ?? []) as OpenQueueLineLookupRow[]) {
    if (!row.product_id) continue;
    const remainingQty = Math.max(0, Number(row.approved_qty ?? 0) - Number(row.fulfilled_qty ?? 0));
    if (remainingQty <= 0) continue;

    const hasLiveAllocation = (row.inventory_allocations ?? []).some((allocation) => (allocation.allocation_status ?? "ALLOCATED") === "ALLOCATED");
    const queueLine: OpenQueueLine = {
      id: row.id,
      product_id: row.product_id,
      remaining_qty: remainingQty,
      priority: row.priority,
      queue_position_start: row.queue_position_start,
      approved_at: row.approved_at,
      created_at: row.created_at,
      has_live_allocation: hasLiveAllocation,
    };

    const lines = queueLinesByProduct.get(row.product_id) ?? [];
    lines.push(queueLine);
    queueLinesByProduct.set(row.product_id, lines);
    queueLineById.set(queueLine.id, queueLine);
  }

  const shippingLineBySkuKey = new Map<string, NonNullable<OrderDetailRow["shipping_order_lines"]>[number]>();
  for (const line of orderLines) {
    const keys = [
      normalizeSkuKey(line.products?.sku),
      normalizeSkuKey(line.legacy_item_code),
      normalizeSkuKey(line.legacy_matched_item_code),
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
    const shippingLine = skuKey
      ? shippingLineBySkuKey.get(skuKey) ?? null
      : item.description === "Invoice line" ? null : orderLines[index] ?? null;
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
  const visibleUnallocatedCount = visibleItems.filter((item) => !item.isNonInventory && (item.shippingLine?.inventory_allocations?.length ?? 0) === 0).length;

  const lineSkuById = new Map(orderLines.map((line) => [line.id, line.products?.sku ?? "Item"]));
  const containerNumberById = new Map(containerOptions.map((container) => [container.id, container.container_number ?? "Container"]));

  const seenActivityKeys = new Set<string>();
  const dedupedActivities = activities.filter((activity) => {
    const key = buildActivityDedupKey(activity);
    if (seenActivityKeys.has(key)) return false;
    seenActivityKeys.add(key);
    return true;
  });

  const timelineActivities = dedupedActivities.slice(0, 10).map((activity) => ({
    ...activity,
    message: describeActivityEvent(activity, lineSkuById, containerNumberById),
  }));

  const contactAddress = cleanAddressForHeader(
    quickbooksSnapshot?.shipping_address,
    orderRecord.customers?.phone,
    orderRecord.customers?.email,
  );

  function getItemSupplySnapshot(item: InvoiceItem): ItemSupplySnapshot {
    if (item.isNonInventory) {
      return {
        comingFrom: "N/A",
        availability: "No inventory required",
        fulfillment: "N/A",
        action: "N/A",
        suggestion: null,
      };
    }

    const line = item.shippingLine;
    const itemStatus = deriveItemStatus(item);

    if (line && (line.inventory_allocations?.length ?? 0) > 0) {
      const allocations = line.inventory_allocations ?? [];
      const distinctSources = new Set(allocations.map((allocation) => allocation.source_type ?? "UNASSIGNED"));

      if (allocations.length > 1 || distinctSources.size > 1) {
        const parts = allocations.map((allocation) => {
          const qty = Number(allocation.quantity ?? 0);
          if (allocation.source_type === "FLOOR") {
            return `Warehouse ${qty}`;
          }
          if (allocation.source_type === "CONTAINER") {
            const containerName = allocation.containers?.container_number ?? "Container";
            const eta = formatDate(allocation.containers?.eta_confirmed_date ?? allocation.containers?.eta_estimated_date);
            return `${containerName} ${qty} (ETA ${eta})`;
          }
          return `Unassigned ${qty}`;
        });

        return {
          comingFrom: "Split",
          availability: parts.join(" + "),
          fulfillment: itemStatus,
          action: "Manage",
          suggestion: null,
        };
      }

      const allocation = allocations[0];
      if (allocation?.source_type === "FLOOR") {
        const floorAvailable = item.productId
          ? Math.max(0, (onFloorAvailableByProduct.get(item.productId) ?? 0) - (floorCommittedByProduct.get(item.productId) ?? 0))
          : 0;
        return {
          comingFrom: "Warehouse",
          availability: floorAvailable > 0 ? `${floorAvailable} available now` : `${Number(allocation.quantity ?? 0)} assigned`,
          fulfillment: itemStatus,
          action: "Manage",
          suggestion: null,
        };
      }

      if (allocation?.source_type === "CONTAINER") {
        const containerName = allocation.containers?.container_number ?? "Container";
        const eta = formatDate(allocation.containers?.eta_confirmed_date ?? allocation.containers?.eta_estimated_date);
        return {
          comingFrom: containerName,
          availability: `ETA ${eta}`,
          fulfillment: itemStatus,
          action: "Manage",
          suggestion: null,
        };
      }

      return {
        comingFrom: "Unassigned",
        availability: "No source selected",
        fulfillment: itemStatus,
        action: "Manage",
        suggestion: null,
      };
    }

    const productId = item.productId;
    if (!productId) {
      return {
        comingFrom: "⚠ Needs mapping",
        availability: "—",
        fulfillment: "Waiting",
        action: "Map SKU",
        suggestion: null,
      };
    }

    const remainingQty = line
      ? Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0))
      : Math.max(0, item.orderedQty);

    if (!line || remainingQty <= 0) {
      return {
        comingFrom: "Unassigned",
        availability: "No source available",
        fulfillment: "Waiting",
        action: "Map SKU",
        suggestion: null,
      };
    }

    const queueLine = queueLineById.get(line.id) ?? {
      id: line.id,
      product_id: productId,
      remaining_qty: remainingQty,
      priority: line.priority,
      queue_position_start: line.queue_position_start,
      approved_at: null,
      created_at: orderRecord?.created_at ?? new Date().toISOString(),
      has_live_allocation: false,
    };

    const suggested = getSuggestedAllocation(queueLine, {
      floorAvailableByProduct,
      queueLinesByProduct,
      containerSupplyByProduct,
    });

    if (suggested.source_type === "WAREHOUSE") {
      const availableNow = floorAvailableByProduct.get(productId) ?? 0;
      return {
        comingFrom: "Warehouse",
        availability: `${Math.max(0, availableNow)} available now`,
        fulfillment: "Ready",
        action: "Manage",
        suggestion: suggested,
      };
    }

    if (suggested.source_type === "CONTAINER") {
      return {
        comingFrom: suggested.container_number ?? "Container",
        availability: suggested.eta_date ? `ETA ${formatDate(suggested.eta_date)}` : "ETA pending",
        fulfillment: "Waiting",
        action: "Manage",
        suggestion: suggested,
      };
    }

    return {
      comingFrom: "Unassigned",
      availability: "No source available",
      fulfillment: "Waiting",
      action: line ? "Manage" : "Map SKU",
      suggestion: suggested,
    };
  }

  const itemStockSummary = visibleItems.map((item) => {
    const supply = getItemSupplySnapshot(item);
    const needed = item.isNonInventory ? 0 : Math.max(0, item.orderedQty);
    const fulfilled = Math.min(needed, Number(item.shippingLine?.fulfilled_qty ?? 0));
    const floorAvailable = item.productId ? Math.max(0, Number(onFloorAvailableByProduct.get(item.productId) ?? 0)) : 0;
    const inStock = Math.min(Math.max(0, needed - fulfilled), floorAvailable) + fulfilled;
    const status = item.isNonInventory
      ? "N/A"
      : fulfilled >= needed
      ? "Fulfilled"
      : inStock >= needed
        ? "In Stock"
        : supply.suggestion?.source_type === "CONTAINER"
          ? "Incoming"
          : inStock > 0
            ? "Partial"
            : "Waiting";
    return { item, supply, needed, inStock, fulfilled, status };
  });

  const totalUnitsNeeded = itemStockSummary.reduce((sum, row) => sum + row.needed, 0);
  const totalUnitsInStock = itemStockSummary.reduce((sum, row) => sum + Math.min(row.needed, row.inStock), 0);
  const totalUnitsShipped = itemStockSummary.reduce((sum, row) => sum + row.fulfilled, 0);
  const overallStatus = totalUnitsShipped >= totalUnitsNeeded && totalUnitsNeeded > 0
    ? "Fulfilled"
    : totalUnitsShipped > 0
      ? "Partially Shipped"
      : totalUnitsInStock >= totalUnitsNeeded && totalUnitsNeeded > 0
        ? "Ready to Ship"
        : totalUnitsInStock > 0
          ? "Partial"
          : "Waiting for Inventory";

  const shipReadyItems = itemStockSummary
    .filter(({ item, status }) => Boolean(item.shippingLine?.product_id) && Boolean(item.shippingLine) && status === "In Stock")
    .map(({ item }) => ({
      id: item.shippingLine!.id,
      label: item.description,
      sku: item.sku ?? item.shippingLine!.products?.sku ?? "Mapped item",
      remainingQty: Math.max(0, Number(item.shippingLine!.approved_qty ?? 0) - Number(item.shippingLine!.fulfilled_qty ?? 0)),
    }));

  const hasOpenWarehouseItems = orderLines.some((line) =>
    ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase())
    && Number(line.fulfilled_qty ?? 0) <= 0
    && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(String(line.fulfillment_status ?? "").toUpperCase()),
  );

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

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#d50917]">Working Order</p>
            <h1 className="mt-1 truncate text-2xl font-semibold text-[#111827]">{orderRecord.customers?.company_name ?? orderRecord.customers?.full_name ?? orderRecord.legacy_customer_name ?? "Customer pending"} <span className="font-normal text-[#64748b]">— Invoice #{quickbooksSnapshot?.invoice_number ?? orderRecord.order_number ?? "—"}</span></h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className={`rounded-full px-2.5 py-1 ${metricStatusClass(overallStatus)}`}>{overallStatus}</span>
              {hasOpenWarehouseItems ? (
                  <form action={moveOrderBackToOrdersAction}>
                    <input type="hidden" name="orderId" value={orderRecord.id} />
                    <button type="submit" className="rounded-full bg-[#fff7e6] px-2.5 py-1 text-[#b45309] underline decoration-dotted underline-offset-2">In Warehouse · Move back to Orders</button>
                  </form>
                ) : null}
              <span className={`rounded-full px-2.5 py-1 ${metricStatusClass(quickbooksSnapshot?.payment_status)}`}>{quickbooksSnapshot?.payment_status ?? "Pending"}</span>
              <span className="rounded-full bg-[#f1f5f9] px-2.5 py-1 text-[#475569]">Priority: {highestPriority(orderLines.map((line) => line.priority))}</span>
              <span className="rounded-full bg-[#eef2ff] px-2.5 py-1 text-[#3730a3]">Fulfillment: {orderRecord.fulfillment_method === "WILL_CALL" ? "Will Call" : "Ship"}</span>
              <span className="text-[#64748b]">Order date {formatDate(orderRecord.created_at)}</span>
            </div>
            <p className="mt-2 truncate text-sm text-[#64748b]">{orderRecord.customers?.phone ?? "No phone"} · {orderRecord.customers?.email ?? "No email"} · {contactAddress}</p>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <div className="text-right">
              <p className="text-4xl font-bold leading-none text-[#16a34a]">{totalUnitsInStock} / {totalUnitsNeeded}</p>
              <p className="mt-1 text-xs font-semibold uppercase tracking-[0.1em] text-[#64748b]">In Stock</p>
              <p className="mt-1 text-xs font-medium text-[#b45309]">{Math.max(0, totalUnitsNeeded - totalUnitsInStock - totalUnitsShipped)} still waiting</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <ShipItemsForm orderId={orderRecord.id} items={shipReadyItems} />
            {shippingOrderColumnSet.has("fulfillment_method") ? (
              <form action={updateOrderOperationsAction} className="flex flex-wrap items-center gap-2 rounded-xl border border-[#e5e7eb] bg-white p-2">
                <input type="hidden" name="orderId" value={orderRecord.id} />
                <label htmlFor="warehouse_state" className="text-xs font-semibold text-[#64748b]">Warehouse</label>
                <select id="warehouse_state" name="warehouse_state" defaultValue={hasOpenWarehouseItems ? "IN_WAREHOUSE" : "ORDERS"} className="rounded-lg border border-[#d1d5db] px-2 py-1 text-sm">
                  <option value="ORDERS">Orders</option>
                  <option value="IN_WAREHOUSE">In Warehouse</option>
                </select>
                <label htmlFor="fulfillment_method" className="text-xs font-semibold text-[#64748b]">Fulfillment</label>
                <select id="fulfillment_method" name="fulfillment_method" defaultValue={orderRecord.fulfillment_method ?? "SHIP"} className="rounded-lg border border-[#d1d5db] px-2 py-1 text-sm">
                  <option value="SHIP">Ship</option>
                  <option value="WILL_CALL">Will Call</option>
                </select>
                <button type="submit" className="btn-secondary text-xs">Save</button>
              </form>
            ) : null}
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

      <div className="grid gap-6 xl:grid-cols-[1.7fr_0.9fr]">
        <div className="flex flex-col space-y-6">
          <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-[#111827]">Items</h2>
                <p className="mt-1 text-sm text-[#5a5a5a]">What they bought, what is available, and what can ship now.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[#475569]">
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">{totalUnitsShipped} shipped</span>
                <span className="rounded-full bg-[#f8fafc] px-3 py-1.5">{Math.max(0, totalUnitsNeeded - totalUnitsShipped)} remaining</span>
              </div>
            </div>

            <div className="mt-4 overflow-x-auto">
              <div className="min-w-[900px]">
                <div className="grid grid-cols-[minmax(220px,2fr)_90px_90px_180px_150px_130px_110px] gap-3 border-b border-[#edf2f7] px-2 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">
                  <span>Item</span>
                  <span>Qty Needed</span>
                  <span>In Stock</span>
                  <span>Coming From</span>
                  <span>ETA</span>
                  <span>Status</span>
                  <span>Action</span>
                </div>
                <div>
                  {itemStockSummary.map(({ item, supply, needed, inStock, status }) => {
                    const line = item.shippingLine;
                    const remainingQty = line ? Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)) : Math.max(0, item.orderedQty);
                    const lineHistoryCount = line ? (lineHistoryById[line.id]?.length ?? 0) : 0;
                    const assignedQty = line?.inventory_allocations?.reduce((sum, allocation) => sum + Number(allocation.quantity ?? 0), 0) ?? 0;
                    const assignmentSourceDefault = line?.inventory_allocations?.[0]?.source_type ?? line?.suggested_assignment_source ?? "UNASSIGNED";
                    const qtyAssignedDefault = Math.min(Math.max(1, assignedQty || remainingQty || 1), Math.max(1, remainingQty || 1));
                    const descriptionSummary = truncateText(item.description, 84);

                    return (
                      <details key={item.key} className="border-b border-[#f1f5f9] group">
                        <summary className="grid cursor-pointer grid-cols-[minmax(220px,2fr)_90px_90px_180px_150px_130px_110px] items-start gap-3 px-2 py-4 text-sm text-[#1f2937] list-none">
                          <span>
                            <span className="font-semibold text-[#111827]">{item.sku ?? "—"}</span>
                            <span className="mt-1 block text-xs text-[#64748b]">{descriptionSummary}</span>
                          </span>
                          <span>{needed}</span>
                          <span className="font-semibold text-[#16a34a]">{inStock}</span>
                          <span className="font-medium text-[#111827]">{supply.comingFrom}</span>
                          <span className="text-xs text-[#475569]">{supply.availability.replace(/^ETA /, "")}</span>
                          <span><span className={`inline-flex rounded-full px-2 py-1 text-[11px] font-semibold ${itemStatusClass(status)}`}>{status}</span></span>
                          <span>
                            {line ? (
                              <span className="inline-flex rounded-lg border border-[#d9e2f7] bg-white px-3 py-2 text-xs font-semibold text-[#334155]">Manage</span>
                            ) : item.isNonInventory ? (
                              <span className="inline-flex rounded-lg border border-[#e5e7eb] bg-[#f8fafc] px-3 py-2 text-xs font-semibold text-[#64748b]">No inventory mapping</span>
                            ) : item.productId ? (
                              <span className="inline-flex rounded-lg border border-[#d9e2e8] bg-[#f8fafc] px-3 py-2 text-xs font-semibold text-[#64748b]">Mapped</span>
                            ) : (
                              <Link
                                href={`/product-mappings?source_sku=${encodeURIComponent(item.sku ?? "")}&source_description=${encodeURIComponent(item.description)}&order_id=${encodeURIComponent(orderRecord.id)}`}
                                className="inline-flex rounded-lg border border-[#f1d3a4] bg-[#fff8ec] px-3 py-2 text-xs font-semibold text-[#915b12]"
                              >
                                Map SKU
                              </Link>
                            )}
                          </span>
                        </summary>
                        {line ? <div className="grid gap-4 border-t border-[#eef2f7] bg-[#fafbfc] px-4 py-4 xl:grid-cols-3">
                          <div className="rounded-xl border border-[#e5e7eb] bg-white p-4">
                            <h3 className="text-sm font-semibold text-[#111827]">Inventory Source</h3>
                            <div className="mt-3 space-y-2 text-sm text-[#374151]">
                              <div><span className="font-medium text-[#64748b]">Item:</span> {item.sku ?? "—"} · {item.description}</div>
                              <div><span className="font-medium text-[#64748b]">Current source:</span> {supply.comingFrom}</div>
                              <div><span className="font-medium text-[#64748b]">Availability:</span> {supply.availability}</div>
                            </div>
                            {(line.inventory_allocations?.length ?? 0) === 0 && supply.suggestion && supply.suggestion.source_type !== "UNASSIGNED" ? (
                              <div className="mt-4 rounded-lg border border-[#dbe5f0] bg-[#f8fbff] p-3 text-sm text-[#334155]">
                                <p><span className="font-semibold">Suggested:</span> {supply.suggestion.source_type === "WAREHOUSE" ? "Warehouse" : supply.suggestion.container_number ?? "Container"}</p>
                                <p className="mt-1"><span className="font-semibold">Estimated ETA:</span> {supply.suggestion.eta_type === "AVAILABLE_NOW" ? "Available now" : supply.suggestion.eta_date ? formatDate(supply.suggestion.eta_date) : "Pending"}</p>
                                <p className="mt-1 text-xs text-[#64748b]">{supply.suggestion.reason}</p>
                                <form action={updateOrderLineAssignmentAction} className="mt-2">
                                  <input type="hidden" name="orderId" value={orderRecord.id} />
                                  <input type="hidden" name="lineId" value={line.id} />
                                  <input type="hidden" name="assignment_source" value={supply.suggestion.source_type === "WAREHOUSE" ? "FLOOR" : "CONTAINER"} />
                                  <input type="hidden" name="container_id" value={supply.suggestion.container_id ?? ""} />
                                  <input type="hidden" name="qty_assigned" value={String(Math.max(1, Math.min(remainingQty || 1, supply.suggestion.suggested_qty || 1)))} />
                                  <button className="btn-secondary" type="submit" disabled={remainingQty <= 0}>
                                    {supply.suggestion.source_type === "WAREHOUSE" ? "Assign to warehouse" : "Assign to this container"}
                                  </button>
                                </form>
                              </div>
                            ) : null}
                            <form action={updateOrderLineAssignmentAction} className="mt-4 grid gap-2">
                              <input type="hidden" name="orderId" value={orderRecord.id} />
                              <input type="hidden" name="lineId" value={line.id} />
                              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Inventory source</label>
                              <select name="assignment_source" className="select text-sm" defaultValue={assignmentSourceDefault}>
                                <option value="UNASSIGNED">Unassigned</option>
                                <option value="FLOOR">Warehouse</option>
                                <option value="CONTAINER">Container</option>
                              </select>
                              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Container (when source is Container)</label>
                              <select name="container_id" className="select text-sm" defaultValue={line.inventory_allocations?.[0]?.container_id ?? line.suggested_container_id ?? ""}>
                                <option value="">Select container</option>
                                {containerOptions.map((container) => (
                                  <option key={container.id} value={container.id}>
                                    {(container.container_number ?? "Container")} · {formatStatus(container.lifecycle_status)} · ETA {formatDate(container.eta_confirmed_date ?? container.eta_estimated_date)}
                                  </option>
                                ))}
                              </select>
                              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Qty assigned</label>
                              <input name="qty_assigned" type="number" min="1" max={Math.max(1, remainingQty || 1)} defaultValue={qtyAssignedDefault} className="input" />
                              <p className="text-xs text-[#64748b]">Container status and ETA are read automatically from Containers.</p>
                              <button className="btn-secondary" type="submit" disabled={remainingQty <= 0}>Save Assignment</button>
                            </form>
                            {["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase()) && Number(line.fulfilled_qty ?? 0) <= 0 ? (
                              <form action={moveOrderLineBackToOrdersAction} className="mt-3">
                                <input type="hidden" name="orderId" value={orderRecord.id} />
                                <input type="hidden" name="lineId" value={line.id} />
                                <button className="btn-secondary w-full" type="submit">Move back to Orders</button>
                              </form>
                            ) : null}
                          </div>

                          <div className="rounded-xl border border-[#e5e7eb] bg-white p-4">
                            <h3 className="text-sm font-semibold text-[#111827]">{orderRecord.fulfillment_method === "WILL_CALL" ? "Will Call Pickup" : "Ship"}</h3>
                            {orderRecord.fulfillment_method === "WILL_CALL" ? <p className="mt-1 text-xs text-[#92400e]">Complete Pickup below after the pickup person, acknowledgment, and restricted driver's-license documents are attached.</p> : null}
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
                              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Qty</label>
                              <input name="ship_qty" type="number" min="1" max={remainingQty} step="1" defaultValue={remainingQty > 0 ? 1 : 0} className="input" />
                              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Tracking</label>
                              <input name="tracking_number" className="input" placeholder="Tracking #" required />
                              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Carrier</label>
                              <input name="carrier" className="input" placeholder="Carrier" />
                              <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Ship date</label>
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
                            <div className="mt-5 border-t border-[#eef2f7] pt-4">
                              <h3 className="text-sm font-semibold text-[#111827]">Product Queue Position</h3>
                              <p className="mt-1 text-xs text-[#64748b]">Automatic position: {line.queue_position_start ?? "—"} · Units: {line.queue_position_count ?? 0}</p>
                              <form action={overrideProductQueuePositionAction} className="mt-3 grid gap-2">
                                <input type="hidden" name="lineId" value={line.id} />
                                <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Override position</label>
                                <input name="queue_position" type="number" min="1" defaultValue={line.queue_position_override ?? line.queue_position_start ?? ""} className="input" required />
                                <label className="text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">Reason</label>
                                <input name="queue_position_reason" defaultValue={line.queue_position_override_reason ?? ""} className="input" placeholder="Customer was promised priority" required />
                                <button className="btn-secondary" type="submit">Reorder Product Queue</button>
                              </form>
                            </div>
                            <p className="mt-3 text-xs text-[#64748b]">Line activity events: {lineHistoryCount}</p>
                          </div>
                        </div> : null}
                      </details>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <section className="order-last mt-6 rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm" id="documents">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-[#111827]">Documents</h2>
                <p className="mt-1 text-sm text-[#5a5a5a]">Private order paperwork, pickup records, photos, and installation documents.</p>
              </div>
              <span className="rounded-full bg-[#f1f5f9] px-3 py-1 text-xs font-semibold text-[#475569]">{attachments.length} attached</span>
            </div>
            {hasOrderAttachmentsTable ? (
              <form action={uploadOrderAttachmentAction} className="mt-4 space-y-3" encType="multipart/form-data">
                <input type="hidden" name="order_id" value={orderRecord.id} />
                <AttachmentDropzone uploadedBy={user.fullName ?? "Unknown"} />
                <div className="grid gap-3 md:grid-cols-[180px_1fr_auto] md:items-end">
                  <label className="text-xs font-semibold text-[#64748b]">Document type<select name="document_type" defaultValue={orderRecord.fulfillment_method === "WILL_CALL" ? "PICKUP_RECEIPT" : "OTHER"} className="input mt-1"><option value="OTHER">Other</option><option value="BOL">BOL</option><option value="PACKING_LIST">Packing list</option><option value="PICKUP_RECEIPT">Pickup acknowledgment</option><option value="DRIVERS_LICENSE">Driver's license</option><option value="CUSTOMER_DOCUMENT">Customer document</option><option value="INSTALLATION">Installation</option><option value="PHOTO">Photo</option></select></label>
                  <label className="text-xs font-semibold text-[#64748b]">Note<input name="document_note" className="input mt-1" placeholder="Optional note" /></label>
                  <button type="submit" className="btn-primary">Upload Files</button>
                </div>
              </form>
            ) : <p className="mt-4 text-sm text-[#b45309]">Document storage is not available in the current schema.</p>}
            <div className="mt-5 grid gap-2 md:grid-cols-2">
              {attachmentLinks.filter(Boolean).map((attachment) => (
                <div key={attachment!.id} className="flex items-center justify-between gap-3 rounded-lg border border-[#e5e7eb] bg-[#fafbfc] p-3 text-sm">
                  {attachment!.signedUrl && attachment!.mime_type?.startsWith("image/") ? <a href={attachment!.signedUrl} target="_blank" rel="noreferrer" className="shrink-0"><img src={attachment!.signedUrl} alt={attachment!.file_name ?? "Order document"} className="h-16 w-20 rounded border border-[#dbe3ee] object-cover" /></a> : <div className="flex h-16 w-20 shrink-0 items-center justify-center rounded border border-[#dbe3ee] bg-white text-xs font-semibold text-[#64748b]">FILE</div>}
                  <div className="min-w-0 flex-1"><p className="truncate font-semibold text-[#1f2937]">{attachment!.file_name}</p><p className="text-xs text-[#64748b]">{attachment!.document_type ?? "OTHER"}{attachment!.is_restricted ? " · Restricted" : ""}{attachment!.note ? ` · ${attachment!.note}` : ""}</p></div>
                  {attachment!.signedUrl ? <a href={attachment!.signedUrl} target="_blank" rel="noreferrer" className="btn-secondary shrink-0 text-xs">View document</a> : null}
                  <form action={deleteOrderAttachmentAction}><input type="hidden" name="order_id" value={orderRecord.id} /><input type="hidden" name="attachment_id" value={attachment!.id} /><button type="submit" name="delete_intent" value="DELETE_ATTACHMENT" className="btn-ghost shrink-0 text-xs">Delete</button></form>
                </div>
              ))}
            </div>
            {orderRecord.fulfillment_method === "WILL_CALL" ? (
              <details className="mt-5 rounded-xl border border-[#f5c26b] bg-[#fffbeb] p-4">
                <summary className="cursor-pointer font-semibold text-[#92400e]">Complete Pickup</summary>
                <form action={markOrderLinesPickedUpAction} className="mt-4 space-y-3">
                  <input type="hidden" name="orderId" value={orderRecord.id} />
                  <div className="grid gap-3 md:grid-cols-2"><input name="pickup_person_name" required className="input" placeholder="Pickup person's full name" /><input name="pickup_notes" className="input" placeholder="Optional pickup notes" /></div>
                  <div className="grid gap-3 md:grid-cols-2"><select name="acknowledgment_document_id" required className="input"><option value="">Pickup acknowledgment document</option>{attachments.filter(item => item.document_type === "PICKUP_RECEIPT").map(item => <option key={item.id} value={item.id}>{item.file_name}</option>)}</select><select name="drivers_license_document_id" required className="input"><option value="">Restricted driver's license document</option>{attachments.filter(item => item.document_type === "DRIVERS_LICENSE" && item.is_restricted).map(item => <option key={item.id} value={item.id}>{item.file_name}</option>)}</select></div>
                  <div className="space-y-2"><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#92400e]">Items and quantities</p>{orderLines.filter(line => Number(line.approved_qty ?? 0) > Number(line.fulfilled_qty ?? 0)).map(line => <label key={line.id} className="flex items-center justify-between gap-3 rounded-lg border border-[#f5c26b] bg-white p-2 text-sm"><span>{line.products?.sku ?? "Item"} · remaining {Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0))}</span><input name={`pickup_qty_${line.id}`} type="number" min="0" max={Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0))} step="1" defaultValue="0" className="w-24 rounded border border-[#d1d5db] px-2 py-1" /><input type="hidden" name="line_id" value={line.id} /></label>)}</div>
                  <button type="submit" className="btn-primary">Mark Picked Up</button>
                </form>
              </details>
            ) : null}
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
              <p className="mt-1 text-sm text-[#5a5a5a]">Human-readable order events with duplicates removed.</p>
              <div className="mt-4 space-y-3">
                {timelineActivities.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-4 text-sm text-[#6b7280]">No history has been recorded yet.</div>
                ) : timelineActivities.map((activity) => {
                  return (
                    <div key={activity.id} className="flex items-start gap-3 rounded-xl border border-[#eef2f7] bg-[#fafbfc] p-3 text-sm">
                      <div className="mt-1 h-8 w-8 rounded-full bg-[#eefbf3] text-center text-xs font-bold leading-8 text-[#18794e]">{activity.action?.startsWith("ORDER_LINE") ? "L" : "O"}</div>
                      <div className="flex-1">
                        <p className="font-semibold text-[#111827]">{activity.message}</p>
                        <p className="mt-1 text-xs text-[#64748b]">{formatDate(activity.created_at)} · {activity.actor_id ? actorNameById.get(activity.actor_id) ?? "System" : "System"}</p>
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
