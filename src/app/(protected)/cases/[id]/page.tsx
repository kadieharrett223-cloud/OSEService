import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  addNoteAction,
  addReplacementPartAction,
  updateCaseStatusAction,
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
        .select("id, file_name, file_path, file_size, mime_type, created_at")
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
    (attachments ?? []).map(async (item) => {
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
            <dt className="text-[#5a5a5a]">Serial Number</dt>
            <dd>{caseRecord.serial_number ?? "-"}</dd>
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
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <article className="card p-4 xl:col-span-2">
          <h2 className="text-xl">Activity History</h2>
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
          <h2 className="text-xl">Add Note</h2>
          <form action={addNoteAction} className="mt-3 space-y-2">
            <input type="hidden" name="case_id" value={id} />
            <select name="note_type" className="select">
              <option value="internal">Internal Note</option>
              <option value="customer">Customer-Facing Note</option>
            </select>
            <textarea name="content" rows={4} required className="textarea" placeholder="Record progress or communication" />
            <button type="submit" className="btn-primary w-full">Add Note</button>
          </form>

          <h3 className="mt-5 text-lg">Recent Notes</h3>
          <div className="mt-2 space-y-2">
            {((notes ?? []) as NoteRow[]).slice(0, 8).map((note) => (
              <div key={note.id} className="rounded-md border border-[#ececec] p-2 text-sm">
                <p>{note.content}</p>
                <p className="mt-1 text-xs text-[#6a6a6a]">
                  {note.note_type} • {new Date(note.created_at).toLocaleString()} • {note.access_users?.full_name ?? "Unknown"}
                </p>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="card p-4">
          <h2 className="text-xl">Attachments</h2>
          <form action={uploadAttachmentAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="case_id" value={id} />
            <input type="file" name="attachment" className="input" required />
            <button type="submit" className="btn-primary">Upload</button>
          </form>
          <ul className="mt-3 space-y-2 text-sm">
            {attachmentLinks.map((item) => (
              <li key={item.id} className="rounded-md border border-[#ececec] p-2">
                <p className="font-semibold">{item.file_name}</p>
                <p className="text-xs text-[#6a6a6a]">{item.mime_type ?? "unknown"} • {(item.file_size ?? 0).toLocaleString()} bytes</p>
                {item.url ? (
                  <a className="text-[#b20610] underline" href={item.url} target="_blank" rel="noreferrer">
                    Download
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
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
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}
