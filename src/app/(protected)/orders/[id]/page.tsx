import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { addOrderNoteAction, deleteOrderAttachmentAction, updateOrderLineStatusAction, uploadOrderAttachmentAction } from "../actions";

type OrderDetailRow = {
  id: string;
  order_number: string | null;
  review_status: string | null;
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
    priority: string | null;
    queue_position_start: number | null;
    products?: { sku: string | null; canonical_name: string | null } | null;
    inventory_allocations?: Array<{ quantity: number | null; source_type: string | null; containers?: { container_number: string | null } | null }>;
  }>;
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

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const { id } = await params;

  const [{ data: order }, { data: activityRows }, { data: attachmentRows }] = await Promise.all([
    supabase
      .from("shipping_orders")
      .select(`
        id,
        order_number,
        review_status,
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
          priority,
          queue_position_start,
          products (sku, canonical_name),
          inventory_allocations (quantity, source_type, containers (container_number))
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
  ]);

  const orderRecord = order as OrderDetailRow | null;
  const activities = (activityRows ?? []) as OrderActivityEntry[];
  const attachments = (attachmentRows ?? []) as OrderAttachmentEntry[];
  if (!orderRecord) {
    return <div className="p-6">Order not found.</div>;
  }

  const salesperson = parseSalesperson(orderRecord.qbo_invoices?.raw_payload);
  const overallStatus = orderRecord.shipping_order_lines?.some((line) => line.fulfillment_status === "FULFILLED") ? "Fulfilled" : orderRecord.shipping_order_lines?.some((line) => line.warehouse_status === "IN_WAREHOUSE") ? "In Warehouse" : orderRecord.review_status ?? "Pending";

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
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Inventory</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Order Detail</h1>
            <p className="mt-2 text-sm text-[#5a5a5a]">Operational record for this order and its line-item shipping workflow.</p>
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
              <p className="mt-1 font-semibold text-[#111827]">{orderRecord.customers?.company_name ?? orderRecord.customers?.full_name ?? "Customer pending"}</p>
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
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-[#111827]">Workflow actions</h2>
            <p className="mt-1 text-sm text-[#5a5a5a]">Use these actions to move an order line through review, warehouse, and fulfillment.</p>
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
                    <input type="hidden" name="action" value="fulfill" />
                    <button className="btn-secondary">Fulfill</button>
                  </form>
                  <form action={updateOrderLineStatusAction}>
                    <input type="hidden" name="lineId" value={line.id} />
                    <input type="hidden" name="orderId" value={orderRecord.id} />
                    <input type="hidden" name="action" value="hold" />
                    <button className="btn-secondary">Hold</button>
                  </form>
                </div>
              </div>
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
