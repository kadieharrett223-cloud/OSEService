import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_TYPES, PRIORITIES } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createCaseAction, quickbooksAutofillAction } from "@/app/(protected)/cases/actions";
import { QuickbooksLookup } from "@/app/(protected)/cases/new/quickbooks-lookup";
import { AttachmentDropzone } from "@/app/(protected)/cases/new/attachment-dropzone";
import { DraftTimelineNotes } from "@/app/(protected)/cases/new/draft-timeline-notes";

function composeShippingAddress(address: string, phone?: string, email?: string) {
  const base = String(address ?? "").trim();
  const safePhone = String(phone ?? "").trim();
  const safeEmail = String(email ?? "").trim();

  const lower = base.toLowerCase();
  const extras: string[] = [];

  if (safePhone && !lower.includes(safePhone.toLowerCase())) {
    extras.push(`Phone: ${safePhone}`);
  }

  if (safeEmail && !lower.includes(safeEmail.toLowerCase())) {
    extras.push(`Email: ${safeEmail}`);
  }

  return [base, extras.join(" | ")].filter(Boolean).join("\n");
}

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

  let assignees: Array<{ id: string; full_name: string | null }> = [];
  let assigneeLoadError = false;

  try {
    const { data, error: assigneeError } = await supabase
      .from("access_users")
      .select("id, full_name")
      .order("full_name", { ascending: true });

    if (assigneeError) {
      assigneeLoadError = true;
    } else {
      assignees = data ?? [];
    }
  } catch {
    assigneeLoadError = true;
  }

  const invoiceLink =
    params.quickbooks_invoice_link
    ?? (params.quickbooks_invoice_external_id
      ? `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(params.quickbooks_invoice_external_id)}`
      : "");
  const shippingAddressDisplay = composeShippingAddress(
    params.shipping_address ?? "",
    params.phone,
    params.email,
  );

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

      {assigneeLoadError ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">
          Assignee list is temporarily unavailable. You can still create the case and assign it later.
        </p>
      ) : null}

      {params.prefilled === "1" ? null : (
        <p className="rounded-md border border-[#e7eaef] bg-[#f8fafc] p-3 text-sm text-[#334155]">
          No QuickBooks match is required. You can enter the customer details manually and create the case directly in sandbox mode.
        </p>
      )}

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
        <input type="hidden" name="phone" value={params.phone ?? ""} />
        <input type="hidden" name="email" value={params.email ?? ""} />
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
                <input id="customer_name" name="customer_name" required readOnly={params.prefilled === "1"} className={`input ${params.prefilled === "1" ? "bg-[#f8fafc]" : ""}`} defaultValue={params.customer_name ?? ""} />
              </div>
              <div>
                <label htmlFor="company_name" className="label">Company</label>
                <input id="company_name" name="company_name" readOnly={params.prefilled === "1"} className={`input ${params.prefilled === "1" ? "bg-[#f8fafc]" : ""}`} defaultValue={params.company_name ?? ""} />
              </div>
              <div>
                <label htmlFor="shipping_address" className="label">Shipping Address</label>
                <textarea id="shipping_address" name="shipping_address" rows={4} readOnly={params.prefilled === "1"} className={`textarea ${params.prefilled === "1" ? "bg-[#f8fafc]" : ""}`} defaultValue={shippingAddressDisplay} />
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
                <textarea id="issue_description" name="issue_description" rows={8} className="textarea" placeholder={"Customer reports lift won't raise.\n\nMotor runs.\n\nNo hydraulic movement.\n\nStarted yesterday."} />
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

          </section>
        </div>

        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold text-[#121826]">Resolution / Status</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="status" className="label">Status</label>
              <input id="status" readOnly className="input bg-[#f8fafc]" value="In Progress (auto on create)" />
              <input type="hidden" name="status" value="In Progress" />
            </div>
            <div>
              <label htmlFor="assigned_employee_id" className="label">Assigned To</label>
              <select id="assigned_employee_id" name="assigned_employee_id" className="select" defaultValue="">
                <option value="">Unassigned</option>
                {assignees.map((assignee) => (
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
              <p className="mt-1 text-xs text-[#64748b]">
                Enter a tracking number and use the link that appears after saving to open a universal package tracker.
              </p>
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
