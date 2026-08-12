import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
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

function formatDate(value: string | null | undefined) {
  if (!value) return "Pending";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pending";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const supabase = await createClient();
  const { id } = await params;
  const { error, message } = await searchParams;

  const [{ data: order }, { data: activityRows }, { data: attachmentRows }, { data: containerRows }] = await Promise.all([
    supabase
      .from("shipping_orders")
      .select(`
        id,
        order_number,
        legacy_customer_name,
        review_status,
        promised_ship_date,
        shipping_method,
        notes,
        tracking_number,
        carrier,
        created_at,
        customers (company_name, full_name, email, phone),
        qbo_invoices (id, invoice_number, payment_status, invoice_date, raw_payload),
        shipping_order_lines (
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
        )
      `)
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("audit_log")
      .select("id, action, details, created_at")
      .eq("entity_type", "shipping_order")
      .eq("entity_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("order_attachments")
      .select("id, file_name, file_path, file_size, mime_type, created_at")
      .eq("shipping_order_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("containers")
      .select("id, container_number, lifecycle_status, eta_confirmed_date, eta_estimated_date")
      .in("lifecycle_status", ["ORDERED", "PRODUCTION", "INBOUND", "RECEIVED"])
      .order("eta_confirmed_date", { ascending: true, nullsFirst: false }),
  ]);

  const orderRecord = order as OrderDetailRow | null;
  const activities = (activityRows ?? []) as OrderActivityEntry[];
  const attachments = (attachmentRows ?? []) as OrderAttachmentEntry[];

  if (!orderRecord) {
    return <div className="p-6">Order not found.</div>;
  }

  const containerOptions = (containerRows ?? []) as ContainerOption[];
  const containersById = new Map(containerOptions.map((container) => [container.id, container]));
  const salesperson = parseSalesperson(orderRecord.qbo_invoices?.raw_payload);
  const overallStatus = orderRecord.shipping_order_lines?.some((line) => line.fulfillment_status === "FULFILLED")
    ? "Fulfilled"
    : orderRecord.shipping_order_lines?.some((line) => line.warehouse_status === "IN_WAREHOUSE")
      ? "In Warehouse"
      : orderRecord.review_status ?? "Pending";

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

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-[#111827]">Order summary</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <p className="text-sm font-medium text-[#6b7280]">Customer</p>
              <p className="mt-1 font-semibold text-[#111827]">{orderRecord.customers?.company_name ?? orderRecord.customers?.full_name ?? orderRecord.legacy_customer_name ?? "Customer pending"}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-[#6b7280]">Invoice</p>
              <p className="mt-1 font-semibold text-[#111827]">#{orderRecord.qbo_invoices?.invoice_number ?? orderRecord.order_number ?? "—"}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-[#6b7280]">Salesperson</p>
              <p className="mt-1 font-semibold text-[#111827]">{salesperson ?? "—"}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-[#6b7280]">Status</p>
              <p className="mt-1 font-semibold text-[#111827]">{overallStatus}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-[#6b7280]">Tracking</p>
              <p className="mt-1 font-semibold text-[#111827]">{orderRecord.tracking_number ?? "Not set"}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-[#6b7280]">Carrier</p>
              <p className="mt-1 font-semibold text-[#111827]">{orderRecord.carrier ?? "Not set"}</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-[#111827]">Schedule</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">Scheduling updates feed the shared shipping calendar immediately.</p>
          <form action={updateOrderScheduleAction} className="mt-4 grid gap-3">
            <input type="hidden" name="orderId" value={orderRecord.id} />
            <div>
              <label htmlFor="schedule_date" className="text-sm font-medium text-[#334155]">Shipment / Pickup Date</label>
              <input id="schedule_date" type="date" name="schedule_date" defaultValue={orderRecord.promised_ship_date ?? ""} className="input mt-1" />
            </div>
            <div>
              <label htmlFor="shipping_method" className="text-sm font-medium text-[#334155]">Method</label>
              <input id="shipping_method" name="shipping_method" defaultValue={orderRecord.shipping_method ?? ""} className="input mt-1" placeholder="Pickup, LTL, Olympic Delivery" />
            </div>
            <div>
              <label htmlFor="schedule_notes" className="text-sm font-medium text-[#334155]">Schedule Notes</label>
              <textarea id="schedule_notes" name="schedule_notes" rows={3} defaultValue={orderRecord.notes ?? ""} className="textarea mt-1" placeholder="Optional notes for scheduling" />
            </div>
            <button className="btn-secondary" type="submit">Update Schedule</button>
          </form>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-[#111827]">Line items</h2>
        <div className="mt-4 space-y-3">
          {(orderRecord.shipping_order_lines ?? []).map((line) => {
            const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
            return (
              <div key={line.id} className="rounded-lg border border-[#e5e7eb] bg-[#fafbfc] p-3 text-sm">
                <p className="font-semibold text-[#111827]">{line.products?.sku ?? "SKU pending"}</p>
                <p className="mt-1 text-[#5a5a5a]">Ordered {line.ordered_qty ?? 0} • Approved {line.approved_qty ?? 0} • Remaining {remainingQty}</p>
                <p className="mt-1 text-[#5a5a5a]">Warehouse {formatStatus(line.warehouse_status)} • Fulfillment {formatStatus(line.fulfillment_status)}</p>
                <p className="mt-1 text-[#5a5a5a]">Priority {line.priority ?? "NORMAL"} • Queue {line.queue_position_start ?? "—"}</p>
                <p className="mt-1 text-[#1f2937]"><span className="font-semibold">Inventory Source:</span> {formatAssignmentSource(line)}</p>
                <p className="mt-1 text-[#5a5a5a]"><span className="font-semibold">Legacy / Suggested:</span> {formatSuggestedAssignment(line, containersById)}</p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-[#111827]">Workflow actions</h2>
            <p className="mt-1 text-sm text-[#5a5a5a]">Use these actions to move an order line through review, warehouse, assignment, and shipping.</p>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          {(orderRecord.shipping_order_lines ?? []).map((line) => (
            <div key={line.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-[#111827]">{line.products?.sku ?? "SKU pending"}</p>
                  <p className="mt-1 text-sm text-[#5a5a5a]">Approval {formatStatus(line.approval_status)} • Warehouse {formatStatus(line.warehouse_status)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <form action={updateOrderLineStatusAction}>
                    <input type="hidden" name="lineId" value={line.id} />
                    <input type="hidden" name="orderId" value={orderRecord.id} />
                    <input type="hidden" name="action" value="approve" />
                    <button className="btn-primary">Approve</button>
                  </form>
                  <form action={updateOrderLineStatusAction}>
                    <input type="hidden" name="lineId" value={line.id} />
                    <input type="hidden" name="orderId" value={orderRecord.id} />
                    <input type="hidden" name="action" value="queue" />
                    <button className="btn-secondary">Queue</button>
                  </form>
                  <form action={updateOrderLineStatusAction}>
                    <input type="hidden" name="lineId" value={line.id} />
                    <input type="hidden" name="orderId" value={orderRecord.id} />
                    <input type="hidden" name="action" value="hold" />
                    <button className="btn-secondary">Hold</button>
                  </form>
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-[#dbe5f0] bg-white p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#475569]">Inventory Assignment</p>
                <p className="mt-1 text-sm text-[#334155]">{formatAssignmentSource(line)}</p>
                {line.inventory_allocations?.length ? null : (
                  <p className="mt-2 rounded-md border border-[#dbeafe] bg-[#eff6ff] px-3 py-2 text-sm text-[#1d4ed8]">{formatSuggestedAssignment(line, containersById)}</p>
                )}
                <form action={updateOrderLineAssignmentAction} className="mt-3 grid gap-2 md:grid-cols-[180px_minmax(240px,1fr)_auto]">
                  <input type="hidden" name="orderId" value={orderRecord.id} />
                  <input type="hidden" name="lineId" value={line.id} />
                  <select name="assignment_source" className="select" defaultValue={line.inventory_allocations?.[0]?.source_type ?? line.suggested_assignment_source ?? "UNASSIGNED"}>
                    <option value="UNASSIGNED">Unassigned</option>
                    <option value="FLOOR">On Floor</option>
                    <option value="CONTAINER">Container</option>
                  </select>
                  <select name="container_id" className="select" defaultValue={line.inventory_allocations?.[0]?.container_id ?? line.suggested_container_id ?? ""}>
                    <option value="">Select container (for Container source)</option>
                    {containerOptions.map((container) => (
                      <option key={container.id} value={container.id}>
                        {(container.container_number ?? "Container")} · {formatStatus(container.lifecycle_status)} · ETA {formatDate(container.eta_confirmed_date ?? container.eta_estimated_date)}
                      </option>
                    ))}
                  </select>
                  <button className="btn-secondary" type="submit">Update Assignment</button>
                </form>
              </div>

              <form action={markOrderLineShippedAction} className="mt-3 rounded-lg border border-[#dbe5f0] bg-white p-3">
                <input type="hidden" name="orderId" value={orderRecord.id} />
                <input type="hidden" name="lineId" value={line.id} />
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#475569]">Mark Shipped</p>
                <p className="mt-1 text-xs text-[#64748b]">Tracking number and shipment date are required. Carrier is optional if not applicable. Upload shipping docs in Attachments.</p>
                <div className="mt-3 grid gap-2 md:grid-cols-4">
                  <div>
                    <label className="text-xs font-medium text-[#334155]">Qty</label>
                    <input name="ship_qty" type="number" min="1" step="1" defaultValue={Math.max(1, Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0)))} className="input mt-1" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-[#334155]">Tracking</label>
                    <input name="tracking_number" className="input mt-1" required />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-[#334155]">Carrier</label>
                    <input name="carrier" className="input mt-1" placeholder="Optional" />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-[#334155]">Shipment Date</label>
                    <input name="shipment_date" type="date" className="input mt-1" required />
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
                  <button className="btn-primary" type="submit">Mark Shipped</button>
                </div>
              </form>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-[#111827]">Attachments</h2>
        <form action={uploadOrderAttachmentAction} className="mt-3 space-y-3">
          <input type="hidden" name="order_id" value={orderRecord.id} />
          <input type="file" name="attachments" multiple className="block w-full text-sm text-[#374151]" />
          <button className="btn-primary">Upload files</button>
        </form>

        <div className="mt-4 space-y-2">
          {attachmentLinks.filter((item): item is NonNullable<typeof item> => Boolean(item)).length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-4 text-sm text-[#6b7280]">No attachments yet.</div>
          ) : null}
          {attachmentLinks.filter((item): item is NonNullable<typeof item> => Boolean(item)).map((attachment) => (
            <div key={attachment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#e5e7eb] bg-[#fafbfc] p-3 text-sm">
              <div>
                <p className="font-semibold text-[#111827]">{attachment.file_name}</p>
                <p className="mt-1 text-[#5a5a5a]">{attachment.mime_type ?? "Attachment"} • {attachment.file_size ? `${Math.round(attachment.file_size / 1024)} KB` : "—"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {attachment.signedUrl ? (
                  <a href={attachment.signedUrl} target="_blank" rel="noreferrer" className="btn-secondary inline-flex">Open</a>
                ) : null}
                <form action={deleteOrderAttachmentAction}>
                  <input type="hidden" name="order_id" value={orderRecord.id} />
                  <input type="hidden" name="attachment_id" value={attachment.id} />
                  <button className="btn-secondary">Delete</button>
                </form>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-[#111827]">Add note</h2>
        <form action={addOrderNoteAction} className="mt-3 space-y-3">
          <input type="hidden" name="orderId" value={orderRecord.id} />
          <textarea name="message" rows={3} className="w-full rounded-xl border border-[#d1d5db] p-3 text-sm" placeholder="Add an operational note for this order" />
          <button className="btn-primary">Save note</button>
        </form>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-[#111827]">Timeline</h2>
        <p className="mt-1 text-sm text-[#5a5a5a]">Operational history is captured here as order events are recorded.</p>
        <div className="mt-4 space-y-2">
          {activities.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-4 text-sm text-[#6b7280]">No activity has been recorded yet.</div>
          ) : null}
          {activities.map((activity) => {
            const activityLabel = (activity.action ?? "ORDER_EVENT").replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
            return (
              <div key={activity.id} className="rounded-lg border border-[#e5e7eb] bg-[#fafbfc] p-3 text-sm text-[#374151]">
                <div className="font-semibold text-[#111827]">{activityLabel}</div>
                <div className="mt-1 text-[#5a5a5a]">{activity.details ? JSON.stringify(activity.details) : "No details"}</div>
                <div className="mt-1 text-xs text-[#6b7280]">{new Date(activity.created_at).toLocaleString()}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
