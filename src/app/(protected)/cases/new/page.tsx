import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES, CASE_TYPES, PRIORITIES } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createCaseAction, quickbooksAutofillAction } from "@/app/(protected)/cases/actions";
import { QuickbooksLookup } from "@/app/(protected)/cases/new/quickbooks-lookup";
import { AttachmentDropzone } from "@/app/(protected)/cases/new/attachment-dropzone";
import { DraftTimelineNotes } from "@/app/(protected)/cases/new/draft-timeline-notes";

export default async function CreateCasePage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    prefilled?: string;
    customer_name?: string;
    company_name?: string;
    phone?: string;
    email?: string;
    shipping_address?: string;
    billing_address?: string;
    quickbooks_customer_id?: string;
    quickbooks_invoice_id?: string;
    quickbooks_invoice_number?: string;
    quickbooks_invoice_external_id?: string;
    quickbooks_invoice_link?: string;
    invoice_date?: string;
    invoice_total?: string;
    payment_status?: string;
    date_of_purchase?: string;
    products_purchased?: string;
    case_type?: string;
  }>;
}) {
  const user = await requireUser();
  const supabase = getSupabaseAdmin();

  const params = await searchParams;
  const error = params.error;
  const defaultCaseType = CASE_TYPES.includes((params.case_type ?? "") as (typeof CASE_TYPES)[number])
    ? params.case_type
    : "General";

  const { data: assignees } = await supabase
    .from("access_users")
    .select("id, full_name")
    .order("full_name", { ascending: true });

  const invoiceLink =
    params.quickbooks_invoice_link
    ?? (params.quickbooks_invoice_external_id
      ? `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(params.quickbooks_invoice_external_id)}`
      : "");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-4xl leading-tight text-[#121826]">Create Customer Service Case</h1>
          <p className="text-sm text-[#5a5a5a]">Everything needed to resolve the issue is visible in one workspace.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/cases" className="btn-secondary">Cancel</Link>
          <button type="submit" form="create-case-form" className="btn-primary">Create Case</button>
        </div>
      </div>

      {error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p>
      ) : null}

      {params.prefilled === "1" ? (
        <p className="rounded-md border border-[#b20610] bg-[#fff5f5] p-3 text-sm text-[#8f030d]">
          QuickBooks match found. Customer and invoice details are locked to prevent duplicate typing.
        </p>
      ) : null}

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-[#121826]">Find QuickBooks Customer / Invoice</h2>
          <span className="rounded-full bg-[#e8f9ee] px-2 py-1 text-xs font-semibold text-[#0f6f35]">Connected to QuickBooks</span>
        </div>
        <form action={quickbooksAutofillAction} className="mt-3 space-y-2">
          <QuickbooksLookup />
          <div className="flex justify-end">
            <button type="submit" className="btn-secondary">Find and Prefill</button>
          </div>
        </form>
      </section>

      <form id="create-case-form" action={createCaseAction} className="space-y-4">
        <input type="hidden" name="quickbooks_invoice_id" value={params.quickbooks_invoice_id ?? ""} />
        <input type="hidden" name="quickbooks_invoice_number" value={params.quickbooks_invoice_number ?? ""} />
        <input type="hidden" name="quickbooks_invoice_link" value={invoiceLink} />
        <input type="hidden" name="quickbooks_customer_id" value={params.quickbooks_customer_id ?? ""} />
        <input type="hidden" name="billing_address" value={params.billing_address ?? ""} />
        <input type="hidden" name="invoice_date" value={params.invoice_date ?? ""} />
        <input type="hidden" name="invoice_total" value={params.invoice_total ?? ""} />
        <input type="hidden" name="payment_status" value={params.payment_status ?? ""} />
        <input type="hidden" name="date_of_purchase" value={params.date_of_purchase ?? params.invoice_date ?? ""} />

        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xl font-semibold text-[#121826]">Customer Information</h2>
            <span className="rounded-full bg-[#eef2f7] px-2 py-1 text-xs font-semibold text-[#334155]">Read-only from QuickBooks</span>
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <div className="space-y-2 lg:col-span-2">
              <div>
                <label htmlFor="customer_name" className="label">Customer Name</label>
                <input id="customer_name" name="customer_name" required readOnly className="input bg-[#f8fafc]" defaultValue={params.customer_name ?? ""} />
              </div>
              <div>
                <label htmlFor="company_name" className="label">Company</label>
                <input id="company_name" name="company_name" readOnly className="input bg-[#f8fafc]" defaultValue={params.company_name ?? ""} />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="phone" className="label">Phone</label>
                  <input id="phone" name="phone" readOnly className="input bg-[#f8fafc]" defaultValue={params.phone ?? ""} />
                </div>
                <div>
                  <label htmlFor="email" className="label">Email</label>
                  <input id="email" name="email" type="email" readOnly className="input bg-[#f8fafc]" defaultValue={params.email ?? ""} />
                </div>
              </div>
              <div>
                <label htmlFor="shipping_address" className="label">Shipping Address</label>
                <textarea id="shipping_address" name="shipping_address" rows={2} readOnly className="textarea bg-[#f8fafc]" defaultValue={params.shipping_address ?? ""} />
              </div>
              <div>
                <label htmlFor="customer_note" className="label">Customer Notes</label>
                <textarea id="customer_note" name="customer_note" rows={3} className="textarea" placeholder="Only editable field in this section." />
              </div>
            </div>

            <aside className="space-y-2 rounded-lg border border-[#edf0f4] bg-[#fafbfc] p-3 text-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6a7281]">Invoice Snapshot</p>
              <p><span className="font-semibold">Invoice #:</span> {params.quickbooks_invoice_number ?? "-"}</p>
              <p><span className="font-semibold">Invoice Date:</span> {params.invoice_date ?? "-"}</p>
              <p><span className="font-semibold">Purchase Date:</span> {params.date_of_purchase ?? params.invoice_date ?? "-"}</p>
              <p><span className="font-semibold">Payment Status:</span> {params.payment_status ?? "-"}</p>
              <p><span className="font-semibold">Invoice Total:</span> {params.invoice_total ?? "-"}</p>
              <p><span className="font-semibold">Billing Address:</span> {params.billing_address ?? "-"}</p>
              <div>
                <label htmlFor="products_purchased" className="label">Products Purchased</label>
                <textarea id="products_purchased" readOnly rows={5} className="textarea bg-[#f8fafc]" defaultValue={params.products_purchased ?? ""} />
              </div>
              {invoiceLink ? (
                <a href={invoiceLink} target="_blank" rel="noreferrer" className="btn-secondary inline-flex w-full justify-center">View Full Invoice</a>
              ) : (
                <button type="button" disabled className="btn-secondary inline-flex w-full justify-center opacity-60">View Full Invoice</button>
              )}
            </aside>
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
          <div className="space-y-4">
            <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
              <h2 className="text-xl font-semibold text-[#121826]">Issue Details</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="case_type" className="label">Issue Category</label>
                  <select id="case_type" name="case_type" className="select" defaultValue={defaultCaseType}>
                    {CASE_TYPES.map((caseType) => (
                      <option key={caseType} value={caseType}>{caseType}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="priority" className="label">Priority</label>
                  <select id="priority" name="priority" className="select" defaultValue="Medium">
                    {PRIORITIES.map((priority) => (
                      <option key={priority} value={priority}>{priority}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-3">
                <label htmlFor="issue_description" className="label">Issue Description</label>
                <textarea id="issue_description" name="issue_description" rows={8} required className="textarea" placeholder={"Customer reports lift won't raise.\n\nMotor runs.\n\nNo hydraulic movement.\n\nStarted yesterday."} />
              </div>
            </section>

            <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
              <h2 className="text-xl font-semibold text-[#121826]">Photos & Attachments</h2>
              <p className="mt-1 text-sm text-[#5a5a5a]">Upload unlimited files for this case: JPG, PNG, HEIC, PDF, MP4.</p>
              <div className="mt-3">
                <AttachmentDropzone uploadedBy={user.fullName ?? "Unknown"} />
              </div>
            </section>
          </div>

          <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-[#121826]">Timeline / Notes</h2>
              <span className="badge badge-status">Auto</span>
            </div>
            <p className="mt-2 text-sm text-[#5a5a5a]">No placeholder events are shown. Timeline entries are generated only from real system actions.</p>

            <div className="mt-4 rounded-md border border-[#edf0f4] bg-[#fafbfc] p-3 text-sm text-[#475569]">
              <p className="font-medium">Timeline starts after case creation.</p>
              <p className="mt-1 text-xs">Case created, notes, uploads, status updates, tracking, and workflow actions are auto-recorded with timestamp and employee.</p>
            </div>

            <div className="mt-4">
              <label htmlFor="internal_notes" className="label">Add Internal Note</label>
              <DraftTimelineNotes />
            </div>

            <div className="mt-4">
              <label htmlFor="customer_facing_notes" className="label">Customer-Facing Notes</label>
              <textarea id="customer_facing_notes" name="customer_facing_notes" rows={4} className="textarea" placeholder="Notes safe to share with customer." />
            </div>
          </section>
        </div>

        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold text-[#121826]">Resolution / Status</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="status" className="label">Status</label>
              <select id="status" name="status" className="select" defaultValue="New">
                <option value="New">Open</option>
                <option value="Waiting for Customer">Waiting on Customer</option>
                <option value="Under Review">Waiting on Supplier</option>
                <option value="Parts Ordered">Parts Ordered</option>
                <option value="Closed">Closed</option>
                {CASE_STATUSES.filter((status) => !["New", "Waiting for Customer", "Under Review", "Parts Ordered", "Closed"].includes(status)).map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="assigned_employee_id" className="label">Assigned To</label>
              <select id="assigned_employee_id" name="assigned_employee_id" className="select" defaultValue="">
                <option value="">Unassigned</option>
                {(assignees ?? []).map((assignee) => (
                  <option key={assignee.id} value={assignee.id}>{assignee.full_name ?? "Unknown"}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="eta_date" className="label">ETA</label>
              <input id="eta_date" name="eta_date" type="date" className="input" />
            </div>
            <div className="sm:col-span-2 lg:col-span-2">
              <label htmlFor="next_step" className="label">Next Action</label>
              <input id="next_step" name="next_step" className="input" placeholder="Example: Confirm supplier replacement stock" />
            </div>
            <div>
              <label htmlFor="tracking_number" className="label">Tracking Number</label>
              <input id="tracking_number" name="tracking_number" className="input" placeholder="Optional" />
            </div>
          </div>
        </section>

        <div className="flex items-center justify-between gap-2 rounded-xl border border-[#e7eaef] bg-white p-3 shadow-sm">
          <p className="text-sm text-[#5a5a5a]">Create the case to begin timeline automation and action-driven resolution workflow.</p>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary">Create Case</button>
            <Link href="/cases" className="btn-secondary">Cancel</Link>
          </div>
        </div>
      </form>
    </div>
  );
}
