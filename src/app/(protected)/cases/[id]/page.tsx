import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES, CASE_TYPES, PRIORITIES } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { SaveToast } from "@/app/(protected)/cases/[id]/save-toast";
import { AttachmentDropzone } from "@/app/(protected)/cases/new/attachment-dropzone";
import {
  addCaseWorkflowEventAction,
  addNoteAction,
  deleteAttachmentAction,
  updateCaseIssueDetailsAction,
  updateCaseStatusAction,
  uploadAttachmentAction,
} from "@/app/(protected)/cases/[id]/actions";

type ActivityRow = {
  id: string;
  activity_type: string;
  summary: string;
  details?: { tracking_number?: string } | null;
  created_at: string;
  access_users: { full_name: string | null } | null;
};

type NoteRow = {
  id: string;
  note_type: "internal" | "customer";
  content: string;
  created_at: string;
  access_users: { full_name: string | null } | null;
};

type CaseRecord = {
  id: string;
  case_number: string;
  created_at: string;
  case_type: string;
  status: string;
  priority: string;
  issue_reported_at: string;
  issue_description: string;
  date_of_purchase: string | null;
  quickbooks_invoice_number: string | null;
  quickbooks_invoice_link: string | null;
  created_by: string;
  customers: {
    full_name: string | null;
    company_name: string | null;
    phone: string | null;
    email: string | null;
    shipping_address: string | null;
    quickbooks_customer_id: string | null;
  } | null;
  invoice: {
    invoice_date: string | null;
    invoice_total: number | null;
    payment_status: string | null;
    billing_address: string | null;
    shipping_address: string | null;
    raw_payload: unknown;
    quickbooks_invoice_id: string;
  } | null;
  assigned: { full_name: string | null } | null;
  creator: { full_name: string | null } | null;
};

type AttachmentRow = {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
  uploader: { full_name: string | null } | null;
};

function formatBytes(size: number | null) {
  if (!size || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function parseProductsPurchased(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return "-";

  const payload = rawPayload as { Line?: unknown[] };
  const lines = Array.isArray(payload.Line) ? payload.Line : [];

  const products = lines
    .map((line, index) => {
      if (!line || typeof line !== "object") return null;

      const item = line as {
        Description?: unknown;
        Qty?: unknown;
        SalesItemLineDetail?: { Qty?: unknown; ItemRef?: { name?: unknown } };
      };

      const description = typeof item.Description === "string"
        ? item.Description.trim()
        : typeof item.SalesItemLineDetail?.ItemRef?.name === "string"
          ? item.SalesItemLineDetail.ItemRef.name.trim()
          : "";

      if (!description) return null;

      const qtyRaw = item.SalesItemLineDetail?.Qty ?? item.Qty;
      const qty = typeof qtyRaw === "number" || typeof qtyRaw === "string"
        ? String(qtyRaw).trim()
        : "";

      return `${index + 1}. ${description}${qty ? ` (Qty ${qty})` : ""}`;
    })
    .filter((value): value is string => Boolean(value));

  return products.length > 0 ? products.join("\n") : "-";
}

function activityLabel(activityType: string) {
  const map: Record<string, string> = {
    case_created: "CASE",
    status_changed: "STATUS",
    workflow_status_changed: "WORKFLOW",
    note_added: "NOTE",
    file_uploaded: "FILE",
    file_deleted: "FILE",
    add_tracking_number: "TRACK",
    replacement_part_ordered: "PART",
    replacement_delivered: "DELIVERED",
    waiting_customer: "WAIT",
    waiting_supplier: "WAIT",
    customer_contacted: "CALL",
    send_customer_email: "EMAIL",
    warranty_approved: "WARRANTY",
  };

  return map[activityType] ?? "EVENT";
}

function buildTrackingUrl(trackingNumber: string) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${trackingNumber} package tracking`)}`;
}

function normalizeStatusLabel(status: string) {
  if (status === "Completed" || status === "Closed") return "Resolved";
  return status;
}

export default async function CaseDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string; timeline?: string }>;
}) {
  const user = await requireUser();

  const { id } = await params;
  const { error, success, timeline } = await searchParams;
  const supabase = getSupabaseAdmin();

  const [{ data: caseRecordRaw }, { data: notes }, { data: activity }, { data: attachments }] =
    await Promise.all([
      supabase
        .from("customer_service_cases")
        .select(
          `
          *,
          customers(*),
          invoice:quickbooks_invoices(invoice_date, invoice_total, payment_status, billing_address, shipping_address, raw_payload, quickbooks_invoice_id),
          assigned:access_users!customer_service_cases_assigned_employee_id_access_user_fkey(full_name),
          creator:access_users!customer_service_cases_created_by_access_user_fkey(full_name)
        `,
        )
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("case_notes")
        .select("id, note_type, content, created_at, access_users:created_by(full_name)")
        .eq("case_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("case_activity")
        .select("id, activity_type, summary, details, created_at, access_users:actor_id(full_name)")
        .eq("case_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("case_attachments")
        .select("id, file_name, file_path, file_size, mime_type, created_at, uploader:access_users!case_attachments_uploaded_by_access_user_fkey(full_name)")
        .eq("case_id", id)
        .order("created_at", { ascending: false }),
    ]);

  const caseRecord = caseRecordRaw as unknown as CaseRecord | null;

  if (!caseRecord) {
    return (
      <div className="card p-6">
        <h1 className="text-2xl">Case not found</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">The case may have been removed or is no longer available.</p>
        <Link href="/cases" className="btn-secondary mt-4 inline-flex">Back to Cases</Link>
      </div>
    );
  }

  const attachmentLinks = await Promise.all(
    ((attachments ?? []) as AttachmentRow[]).map(async (item) => {
      const { data } = await supabase.storage
        .from("case-attachments")
        .createSignedUrl(item.file_path, 60 * 60);
      return { ...item, url: data?.signedUrl ?? null };
    }),
  );

  const productsPurchased = parseProductsPurchased(caseRecord.invoice?.raw_payload);
  const noteRows = (notes ?? []) as NoteRow[];
  const allActivityRows = (activity ?? []) as ActivityRow[];
  const activityRows = allActivityRows.filter((row) => row.activity_type !== "note_added");
  const showAllTimeline = timeline === "all";
  const visibleTimelineRows = showAllTimeline ? activityRows : activityRows.slice(0, 5);
  const normalizedStatus = normalizeStatusLabel(caseRecord.status);
  const statusOptions = CASE_STATUSES.filter((status) => status !== "Completed" && status !== "Closed");
  const latestTracking = allActivityRows.find((row) => row.activity_type === "add_tracking_number")?.details?.tracking_number
    ?? allActivityRows.find((row) => row.activity_type === "add_tracking_number")?.summary.split(":").slice(1).join(":").trim()
    ?? "";
  const latestTrackingUrl = latestTracking ? buildTrackingUrl(latestTracking) : "";
  const invoiceLink = caseRecord.quickbooks_invoice_link
    || (caseRecord.invoice?.quickbooks_invoice_id
      ? `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(caseRecord.invoice.quickbooks_invoice_id)}`
      : null);

  return (
    <div className="space-y-4">
      {success === "issue_saved" ? <SaveToast message="Issue details saved" /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-4xl leading-tight text-[#121826]">{caseRecord.case_number}</h1>
          <p className="text-sm text-[#5a5a5a]">Case workspace mirrors intake view for faster follow-up work.</p>
        </div>
        <div className="flex gap-2">
          <span className="badge badge-status">{normalizedStatus}</span>
          <span className={`badge ${caseRecord.priority === "High" ? "badge-priority-high" : "badge-status"}`}>
            {caseRecord.priority}
          </span>
          <Link href="/cases" className="btn-secondary">Back to Cases</Link>
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p>
      ) : null}

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold text-[#121826]">Customer Information</h2>
          <span className="rounded-full bg-[#eef2f7] px-2 py-1 text-xs font-semibold text-[#334155]">QuickBooks Snapshot</span>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          <div className="space-y-2 lg:col-span-2">
            <div>
              <label className="label">Customer Name</label>
              <input readOnly className="input bg-[#f8fafc]" value={caseRecord.customers?.full_name ?? ""} />
            </div>
            <div>
              <label className="label">Company</label>
              <input readOnly className="input bg-[#f8fafc]" value={caseRecord.customers?.company_name ?? ""} />
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label className="label">Phone</label>
                <input readOnly className="input bg-[#f8fafc]" value={caseRecord.customers?.phone ?? ""} />
              </div>
              <div>
                <label className="label">Email</label>
                <input readOnly className="input bg-[#f8fafc]" value={caseRecord.customers?.email ?? ""} />
              </div>
            </div>
            <div>
              <label className="label">Shipping Address</label>
              <textarea readOnly rows={2} className="textarea bg-[#f8fafc]" value={caseRecord.customers?.shipping_address ?? ""} />
            </div>
            <div>
              <label className="label">Customer Notes</label>
                <textarea readOnly rows={3} className="textarea bg-[#f8fafc]" value={noteRows.filter((note) => note.note_type === "customer").map((note) => note.content).join("\n\n") || ""} />
            </div>
          </div>

          <aside className="space-y-2 rounded-lg border border-[#edf0f4] bg-[#fafbfc] p-3 text-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6a7281]">Invoice Snapshot</p>
            <p><span className="font-semibold">Invoice #:</span> {caseRecord.quickbooks_invoice_number ?? "-"}</p>
            <p><span className="font-semibold">Invoice Date:</span> {caseRecord.invoice?.invoice_date ?? "-"}</p>
            <p><span className="font-semibold">Purchase Date:</span> {caseRecord.date_of_purchase ?? caseRecord.invoice?.invoice_date ?? "-"}</p>
            <p><span className="font-semibold">Payment Status:</span> {caseRecord.invoice?.payment_status ?? "-"}</p>
            <p><span className="font-semibold">Invoice Total:</span> {caseRecord.invoice?.invoice_total != null ? `$${caseRecord.invoice.invoice_total.toFixed(2)}` : "-"}</p>
            <p><span className="font-semibold">Billing Address:</span> {caseRecord.invoice?.billing_address ?? "-"}</p>
            <div>
              <label className="label">Products Purchased</label>
              <textarea readOnly rows={5} className="textarea bg-[#f8fafc]" value={productsPurchased} />
            </div>
            {invoiceLink ? (
              <a href={invoiceLink} target="_blank" rel="noreferrer" className="btn-secondary inline-flex w-full justify-center">View Full Invoice</a>
            ) : (
              <button type="button" disabled className="btn-secondary inline-flex w-full justify-center opacity-60">View Full Invoice</button>
            )}
          </aside>
        </div>
      </section>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Issue Details</h2>
        <form action={updateCaseIssueDetailsAction} className="mt-3 space-y-3">
          <input type="hidden" name="case_id" value={id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="case_type" className="label">Issue Category</label>
              <select id="case_type" name="case_type" className="select" defaultValue={caseRecord.case_type ?? "General"}>
                {CASE_TYPES.map((caseType) => (
                  <option key={caseType} value={caseType}>{caseType}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="priority" className="label">Priority</label>
              <select id="priority" name="priority" className="select" defaultValue={caseRecord.priority}>
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>{priority}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="issue_description" className="label">Issue Description</label>
            <textarea id="issue_description" name="issue_description" rows={8} className="textarea" defaultValue={caseRecord.issue_description} required />
          </div>
          <div className="flex justify-end">
            <button type="submit" className="btn-primary">Save Issue Details</button>
          </div>
        </form>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold text-[#121826]">Photos & Attachments</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">Upload unlimited files for this case: JPG, PNG, HEIC, PDF, MP4.</p>

          <form action={uploadAttachmentAction} className="mt-3 space-y-3">
            <input type="hidden" name="case_id" value={id} />
            <AttachmentDropzone uploadedBy={user.fullName ?? "Unknown"} />
            <button type="submit" className="btn-primary">Upload Files</button>
          </form>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {attachmentLinks.map((item) => {
              const isImage = Boolean(item.mime_type?.startsWith("image/"));

              return (
                <div key={item.id} className="rounded-md border border-[#ececec] p-2 text-sm">
                  <div className="mb-2 flex h-28 items-center justify-center rounded-md bg-[#f5f7fb]">
                    {isImage && item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer" className="h-full w-full">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={item.url} alt={item.file_name} className="h-full w-full rounded-md object-cover" />
                      </a>
                    ) : (
                      <span className="text-xs text-[#64748b]">{item.mime_type ?? "File"}</span>
                    )}
                  </div>
                  <p className="truncate font-semibold" title={item.file_name}>{item.file_name}</p>
                  <p className="text-xs text-[#6a6a6a]">Size: {formatBytes(item.file_size)}</p>
                  <p className="text-xs text-[#6a6a6a]">Upload date: {new Date(item.created_at).toLocaleString()}</p>
                  <p className="text-xs text-[#6a6a6a]">Uploaded by: {item.uploader?.full_name ?? "Unknown"}</p>
                  <div className="mt-2 flex gap-2">
                    {item.url ? (
                      <a className="btn-secondary text-xs" href={item.url} target="_blank" rel="noreferrer">View</a>
                    ) : null}
                    <form action={deleteAttachmentAction}>
                      <input type="hidden" name="case_id" value={id} />
                      <input type="hidden" name="attachment_id" value={item.id} />
                      <button type="submit" className="btn-danger text-xs">Delete</button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h3 className="text-lg font-semibold text-[#121826]">Internal Notes</h3>
          <form action={addNoteAction} className="mt-3 space-y-2">
            <input type="hidden" name="case_id" value={id} />
            <input type="hidden" name="note_type" value="internal" />
            <label htmlFor="content" className="label">Add Internal Note</label>
            <textarea id="content" name="content" rows={3} required className="textarea" placeholder="Add internal note" />
            <button type="submit" className="btn-primary">Add Note</button>
          </form>
          <div className="mt-2 space-y-2">
            {noteRows.filter((note) => note.note_type === "internal").slice(0, 8).map((note) => (
              <div key={note.id} className="rounded-md border border-[#ececec] p-2 text-sm">
                <p>{note.content}</p>
                <p className="mt-1 text-xs text-[#6a6a6a]">
                  {new Date(note.created_at).toLocaleString()} • {note.access_users?.full_name ?? "Unknown"} • {note.note_type}
                </p>
              </div>
            ))}
            {noteRows.filter((note) => note.note_type === "internal").length === 0 ? (
              <p className="rounded-md border border-[#edf0f4] bg-[#fafbfc] p-3 text-sm text-[#64748b]">No notes yet.</p>
            ) : null}
          </div>
        </section>
      </div>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Case Workflow</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <form action={updateCaseStatusAction} className="space-y-2">
            <input type="hidden" name="case_id" value={id} />
            <label htmlFor="status" className="label">Status</label>
            <select id="status" name="status" defaultValue={normalizedStatus} className="select">
              {statusOptions.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
            <button type="submit" className="btn-primary w-full">Save Status</button>
          </form>

          <div className="space-y-2">
            <label className="label">Reported</label>
            <input
              readOnly
              className="input bg-[#f8fafc]"
              value={new Date(caseRecord.issue_reported_at || caseRecord.created_at).toLocaleString()}
            />
          </div>

          <form action={addCaseWorkflowEventAction} className="space-y-2">
            <input type="hidden" name="case_id" value={id} />
            <input type="hidden" name="event_type" value="add_tracking_number" />
            <label htmlFor="tracking_number" className="label">Tracking Number</label>
            <input id="tracking_number" name="tracking_number" className="input" placeholder="Enter tracking number" />
            <button type="submit" className="btn-secondary w-full">Add Tracking Number</button>
            {latestTrackingUrl ? (
              <a href={latestTrackingUrl} target="_blank" rel="noreferrer" className="inline-flex text-xs font-semibold text-[#b20610] underline">
                Track latest package ({latestTracking})
              </a>
            ) : null}
          </form>
        </div>

      </section>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-[#121826]">Timeline</h2>
          <span className="badge badge-status">Auto</span>
        </div>
        <p className="mt-2 text-sm text-[#5a5a5a]">Generated from real actions with timestamp and employee.</p>

        <div className="mt-3 space-y-2">
          {visibleTimelineRows.map((row) => (
            <div key={row.id} className="rounded-md border border-[#ececec] p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="rounded bg-[#f1f5f9] px-2 py-0.5 text-[11px] font-semibold text-[#475569]">{activityLabel(row.activity_type)}</span>
                <span className="text-xs text-[#6a6a6a]">{new Date(row.created_at).toLocaleString()}</span>
              </div>
              <p className="mt-1 font-semibold text-[#1f2937]">{row.summary}</p>
              <p className="text-xs text-[#6a6a6a]">By {row.access_users?.full_name ?? "System"}</p>
              {row.activity_type === "add_tracking_number" && (row.details?.tracking_number || row.summary.includes(":")) ? (
                <a
                  href={buildTrackingUrl(row.details?.tracking_number ?? row.summary.split(":").slice(1).join(":").trim())}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex text-xs font-semibold text-[#b20610] underline"
                >
                  Track package
                </a>
              ) : null}
            </div>
          ))}
          {activityRows.length === 0 ? (
            <p className="rounded-md border border-[#edf0f4] bg-[#fafbfc] p-3 text-sm text-[#64748b]">No timeline events yet.</p>
          ) : null}

          {activityRows.length > 5 ? (
            <div className="pt-1 text-right">
              <Link
                href={showAllTimeline ? `/cases/${id}` : `/cases/${id}?timeline=all`}
                className="inline-flex text-xs font-semibold text-[#b20610] underline"
              >
                {showAllTimeline ? "Show Less" : "View All"}
              </Link>
            </div>
          ) : null}
        </div>

        <div className="mt-4 rounded-md border border-[#edf0f4] bg-[#fafbfc] p-3 text-xs text-[#6a7281]">
          <p className="font-semibold uppercase tracking-[0.08em]">Workflow Actions</p>
          <form action={addCaseWorkflowEventAction} className="mt-2 grid grid-cols-2 gap-2">
            <input type="hidden" name="case_id" value={id} />
            <button type="submit" name="event_type" value="customer_contacted" className="btn-secondary text-xs">Customer Contacted</button>
            <button type="submit" name="event_type" value="send_customer_email" className="btn-secondary text-xs">Send Customer Email</button>
            <button type="submit" name="event_type" value="replacement_part_ordered" className="btn-secondary text-xs">Order Replacement Part</button>
            <button type="submit" name="event_type" value="waiting_supplier" className="btn-secondary text-xs">Waiting on Supplier</button>
            <button type="submit" name="event_type" value="waiting_customer" className="btn-secondary text-xs">Waiting on Customer</button>
            <button type="submit" name="event_type" value="replacement_delivered" className="btn-secondary text-xs">Replacement Delivered</button>
          </form>
        </div>
      </section>
    </div>
  );
}
