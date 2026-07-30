import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  addCaseWorkflowEventAction,
  addNoteAction,
  addReplacementPartAction,
  deleteAttachmentAction,
  updateCaseStatusAction,
  updateCaseWorkflowAction,
  uploadAttachmentAction,
} from "@/app/(protected)/cases/[id]/actions";

type ActivityRow = {
  id: string;
  summary: string;
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
  case_type: string;
  status: string;
  priority: string;
  issue_reported_at: string;
  issue_description: string;
  product_model: string | null;
  serial_number: string | null;
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

export default async function CaseDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireUser();

  const { id } = await params;
  const { error } = await searchParams;
  const supabase = getSupabaseAdmin();

  const [{ data: caseRecordRaw }, { data: notes }, { data: parts }, { data: activity }, { data: attachments }] =
    await Promise.all([
      supabase
        .from("customer_service_cases")
        .select(
          `
          *,
          customers(*),
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
        .from("replacement_parts")
        .select("*")
        .eq("case_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("case_activity")
        .select("id, activity_type, summary, created_at, access_users:actor_id(full_name)")
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-[#5a5a5a]">Case</p>
          <h1 className="text-3xl">{caseRecord.case_number}</h1>
          <p className="text-sm text-[#5a5a5a]">{caseRecord.case_type ?? "General"}</p>
        </div>
        <div className="flex gap-2">
          <span className="badge badge-status">{caseRecord.status}</span>
          <span className={`badge ${caseRecord.priority === "High" ? "badge-priority-high" : "badge-status"}`}>
            {caseRecord.priority}
          </span>
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="card p-4">
          <h2 className="text-xl">Customer and Invoice</h2>
          <dl className="mt-3 grid grid-cols-[170px,1fr] gap-y-2 text-sm">
            <dt className="text-[#5a5a5a]">Customer</dt>
            <dd>{caseRecord.customers?.full_name}</dd>
            <dt className="text-[#5a5a5a]">Company</dt>
            <dd>{caseRecord.customers?.company_name ?? "-"}</dd>
            <dt className="text-[#5a5a5a]">Phone</dt>
            <dd>{caseRecord.customers?.phone ?? "-"}</dd>
            <dt className="text-[#5a5a5a]">Email</dt>
            <dd>{caseRecord.customers?.email ?? "-"}</dd>
            <dt className="text-[#5a5a5a]">Shipping Address</dt>
            <dd>{caseRecord.customers?.shipping_address ?? "-"}</dd>
            <dt className="text-[#5a5a5a]">QB Customer ID</dt>
            <dd>{caseRecord.customers?.quickbooks_customer_id ?? "-"}</dd>
            <dt className="text-[#5a5a5a]">Invoice Number</dt>
            <dd>{caseRecord.quickbooks_invoice_number ?? "-"}</dd>
            <dt className="text-[#5a5a5a]">Invoice Link</dt>
            <dd>
              {caseRecord.quickbooks_invoice_link ? (
                <a href={caseRecord.quickbooks_invoice_link} target="_blank" rel="noreferrer" className="text-[#b20610] underline">
                  Open Invoice
                </a>
              ) : (
                "-"
              )}
            </dd>
          </dl>
        </article>

        <article className="card p-4">
          <h2 className="text-xl">Issue and Assignment</h2>
          <dl className="mt-3 grid grid-cols-[170px,1fr] gap-y-2 text-sm">
            <dt className="text-[#5a5a5a]">Product Model</dt>
            <dd>{caseRecord.product_model ?? "-"}</dd>
            <dt className="text-[#5a5a5a]">Date of Purchase</dt>
            <dd>{caseRecord.date_of_purchase ?? "-"}</dd>
            <dt className="text-[#5a5a5a]">Issue Reported</dt>
            <dd>{new Date(caseRecord.issue_reported_at).toLocaleString()}</dd>
            <dt className="text-[#5a5a5a]">Assigned Employee</dt>
            <dd>{caseRecord.assigned?.full_name ?? "Unassigned"}</dd>
            <dt className="text-[#5a5a5a]">Created By</dt>
            <dd>{caseRecord.creator?.full_name ?? caseRecord.created_by}</dd>
            <dt className="text-[#5a5a5a]">Description</dt>
            <dd className="whitespace-pre-wrap">{caseRecord.issue_description}</dd>
          </dl>

          <form action={updateCaseStatusAction} className="mt-4 flex flex-wrap items-end gap-2 border-t border-[#ececec] pt-4">
            <input type="hidden" name="case_id" value={id} />
            <div>
              <label htmlFor="status" className="label">Update Status</label>
              <select id="status" name="status" defaultValue={caseRecord.status} className="select min-w-[220px]">
                {CASE_STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-primary">Save Status</button>
          </form>

          <form action={updateCaseWorkflowAction} className="mt-3 flex flex-wrap gap-2">
            <input type="hidden" name="case_id" value={id} />
            <button type="submit" name="workflow_action" value="mark_in_progress" className="btn-secondary">
              Mark In Progress
            </button>
            <button type="submit" name="workflow_action" value="mark_completed" className="btn-primary">
              Mark Completed
            </button>
            <button type="submit" name="workflow_action" value="reopen_case" className="btn-secondary">
              Reopen Case
            </button>
          </form>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <article className="card p-4 xl:col-span-2">
          <h2 className="text-xl">Timeline</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">Generated from actual actions in this case.</p>
          <div className="mt-3 space-y-3">
            {((activity ?? []) as ActivityRow[]).map((row) => (
              <div key={row.id} className="rounded-md border border-[#ececec] p-3 text-sm">
                <p className="font-semibold">{row.summary}</p>
                <p className="text-xs text-[#6a6a6a]">
                  {new Date(row.created_at).toLocaleString()} by {row.access_users?.full_name ?? "System"}
                </p>
              </div>
            ))}
          </div>
        </article>

        <article className="card p-4">
          <h2 className="text-xl">Resolution Actions</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">Use action buttons to move work forward and append timeline entries automatically.</p>

          <form action={addCaseWorkflowEventAction} className="mt-3 grid grid-cols-2 gap-2">
            <input type="hidden" name="case_id" value={id} />
            <button type="submit" name="event_type" value="customer_contacted" className="btn-secondary text-sm">Customer Contacted</button>
            <button type="submit" name="event_type" value="send_customer_email" className="btn-secondary text-sm">Send Customer Email</button>
            <button type="submit" name="event_type" value="replacement_part_ordered" className="btn-secondary text-sm">Order Replacement Part</button>
            <button type="submit" name="event_type" value="generate_warranty_claim" className="btn-secondary text-sm">Generate Warranty Claim</button>
            <button type="submit" name="event_type" value="request_supplier_approval" className="btn-secondary text-sm">Request Supplier Approval</button>
            <button type="submit" name="event_type" value="schedule_technician" className="btn-secondary text-sm">Schedule Technician</button>
            <button type="submit" name="event_type" value="waiting_supplier" className="btn-secondary text-sm">Mark Waiting on Supplier</button>
            <button type="submit" name="event_type" value="waiting_customer" className="btn-secondary text-sm">Mark Waiting on Customer</button>
            <button type="submit" name="event_type" value="warranty_approved" className="btn-secondary text-sm">Warranty Approved</button>
            <button type="submit" name="event_type" value="replacement_delivered" className="btn-secondary text-sm">Replacement Delivered</button>
          </form>

          <form action={addCaseWorkflowEventAction} className="mt-3 flex items-end gap-2">
            <input type="hidden" name="case_id" value={id} />
            <input type="hidden" name="event_type" value="add_tracking_number" />
            <div className="flex-1">
              <label htmlFor="tracking_number" className="label">Add Tracking Number</label>
              <input id="tracking_number" name="tracking_number" className="input" placeholder="Enter tracking number" />
            </div>
            <button type="submit" className="btn-primary">Add Tracking Number</button>
          </form>

          <form action={addNoteAction} className="mt-4 space-y-2 border-t border-[#ececec] pt-4">
            <input type="hidden" name="case_id" value={id} />
            <input type="hidden" name="note_type" value="internal" />
            <textarea name="content" rows={3} required className="textarea" placeholder="Internal note (auto-added to timeline)." />
            <button type="submit" className="btn-primary w-full">Add Internal Note</button>
          </form>

          <h3 className="mt-5 text-lg">Recent Notes</h3>
          <div className="mt-2 space-y-2">
            {((notes ?? []) as NoteRow[]).slice(0, 8).map((note) => (
              <div key={note.id} className="rounded-md border border-[#ececec] p-2 text-sm">
                <p>{note.content}</p>
                <p className="mt-1 text-xs text-[#6a6a6a]">
                  {new Date(note.created_at).toLocaleString()} • {note.access_users?.full_name ?? "Unknown"}
                </p>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="card p-4">
          <h2 className="text-xl">Attachments</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">Upload unlimited images and files (JPG, PNG, HEIC, PDF, MP4).</p>
          <form action={uploadAttachmentAction} className="mt-3 space-y-3">
            <input type="hidden" name="case_id" value={id} />
            <label htmlFor="attachments" className="flex min-h-[120px] cursor-pointer items-center justify-center rounded-lg border border-dashed border-[#c9d1dd] bg-[#f8fafc] px-4 py-6 text-center text-sm text-[#475569]">
              Drag and drop files here, or click to browse
            </label>
            <input id="attachments" type="file" name="attachments" className="sr-only" accept=".jpg,.jpeg,.png,.heic,.pdf,.mp4" multiple required />
            <button type="submit" className="btn-primary">Upload Files</button>
          </form>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {attachmentLinks.map((item) => {
              const isImage = Boolean(item.mime_type?.startsWith("image/"));

              return (
                <div key={item.id} className="rounded-md border border-[#ececec] p-2 text-sm">
                  <div className="mb-2 flex h-28 items-center justify-center rounded-md bg-[#f5f7fb]">
                    {isImage && item.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.url} alt={item.file_name} className="h-full w-full rounded-md object-cover" />
                    ) : (
                      <span className="text-xs text-[#64748b]">{item.mime_type ?? "File"}</span>
                    )}
                  </div>
                  <p className="truncate font-semibold" title={item.file_name}>{item.file_name}</p>
                  <p className="text-xs text-[#6a6a6a]">Uploaded {new Date(item.created_at).toLocaleString()}</p>
                  <p className="text-xs text-[#6a6a6a]">By {item.uploader?.full_name ?? "Unknown"}</p>
                  <div className="mt-2 flex gap-2">
                    {item.url ? (
                      <a className="btn-secondary text-xs" href={item.url} target="_blank" rel="noreferrer">Download</a>
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
        </article>

        <article className="card p-4">
          <h2 className="text-xl">Replacement Parts</h2>
          <form action={addReplacementPartAction} className="mt-3 grid gap-2 md:grid-cols-2">
            <input type="hidden" name="case_id" value={id} />
            <input name="part_name" placeholder="Part name" required className="input md:col-span-2" />
            <input name="sku" placeholder="SKU" className="input" />
            <input name="quantity" type="number" min={1} defaultValue={1} className="input" />
            <input name="supplier" placeholder="Supplier" className="input" />
            <input name="cost" type="number" step="0.01" placeholder="Cost" className="input" />
            <input name="shipping_status" placeholder="Shipping status" className="input" />
            <input name="carrier" placeholder="Carrier" className="input" />
            <input name="tracking_number" placeholder="Tracking number" className="input md:col-span-2" />
            <input name="order_date" type="date" className="input" />
            <input name="ship_date" type="date" className="input" />
            <input name="delivery_date" type="date" className="input" />
            <textarea name="notes" rows={2} placeholder="Notes" className="textarea md:col-span-2" />
            <button type="submit" className="btn-primary md:col-span-2">Add Replacement Part</button>
          </form>

          <div className="mt-3 space-y-2 text-sm">
            {(parts ?? []).map((part) => (
              <div key={part.id} className="rounded-md border border-[#ececec] p-2">
                <p className="font-semibold">{part.part_name}</p>
                <p>Qty: {part.quantity} • SKU: {part.sku ?? "-"} • Supplier: {part.supplier ?? "-"}</p>
                <p>Status: {part.shipping_status ?? "-"} • Tracking: {part.tracking_number ?? "-"}</p>
                <p className="text-xs text-[#6a6a6a]">Added {new Date(part.created_at).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}
