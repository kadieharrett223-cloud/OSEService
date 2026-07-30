import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES, CASE_TYPES, PRIORITIES } from "@/lib/constants";
import { createCaseAction, quickbooksAutofillAction } from "@/app/(protected)/cases/actions";
import { QuickbooksLookup } from "@/app/(protected)/cases/new/quickbooks-lookup";

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
    invoice_date?: string;
    invoice_total?: string;
    payment_status?: string;
    case_type?: string;
  }>;
}) {
  await requireUser();

  const params = await searchParams;
  const error = params.error;
  const defaultCaseType = CASE_TYPES.includes((params.case_type ?? "") as (typeof CASE_TYPES)[number])
    ? params.case_type
    : "General";
  const recentSearches = [
    params.customer_name,
    params.company_name,
    params.quickbooks_invoice_number,
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl leading-tight text-[#121826]">Create Customer Service Case</h1>
          <p className="text-sm text-[#5a5a5a]">Fast intake workspace for customer, invoice, issue, and workflow tracking.</p>
        </div>
        <Link href="/cases" className="btn-secondary">
          Back to Cases
        </Link>
      </div>

      {error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p>
      ) : null}

      {params.prefilled === "1" ? (
        <p className="rounded-md border border-[#b20610] bg-[#fff5f5] p-3 text-sm text-[#8f030d]">
          QuickBooks match found. Review and adjust any fields before saving.
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold text-[#121826]">1. Customer</h2>
          <p className="mt-1 text-xs text-[#5a5a5a]">Match invoice/customer first so key details auto-fill from QuickBooks.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor="matched_invoice_display" className="label">Matched Invoice Number</label>
              <input id="matched_invoice_display" className="input" value={params.quickbooks_invoice_number ?? ""} readOnly placeholder="Auto-filled from QuickBooks lookup" />
            </div>
            <div>
              <label htmlFor="case_type" className="label">Case Type</label>
              <select id="case_type" name="case_type" className="select" defaultValue={defaultCaseType} form="create-case-form">
                {CASE_TYPES.map((caseType) => (
                  <option key={caseType} value={caseType}>{caseType}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="priority" className="label">Priority</label>
              <select id="priority" name="priority" className="select" defaultValue="Medium" form="create-case-form">
                {PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>{priority}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="status" className="label">Status</label>
              <select id="status" name="status" className="select" defaultValue="New" form="create-case-form">
                {CASE_STATUSES.map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold text-[#121826]">Quick Actions</h2>
          <p className="mt-1 text-xs text-[#5a5a5a]">Find customer and invoice details without manual re-entry.</p>
          <form action={quickbooksAutofillAction} className="mt-3 space-y-2">
            <QuickbooksLookup />
            <div className="flex justify-end">
              <button type="submit" className="btn-secondary">Find and Prefill</button>
            </div>
          </form>

          <div className="mt-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6a7281]">Recent Searches</h3>
            <ul className="space-y-1 text-sm text-[#303644]">
              {(recentSearches.length ? recentSearches : ["No recent searches yet"]).slice(0, 3).map((item, index) => (
                <li key={`${item}-${index}`} className="rounded-md border border-[#edf0f4] bg-[#fafbfc] px-2 py-1.5">
                  {item}
                </li>
              ))}
            </ul>

            <h3 className="pt-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#6a7281]">Last Invoice Found</h3>
            <div className="rounded-md border border-[#edf0f4] bg-[#fafbfc] p-2 text-sm text-[#303644]">
              <p className="font-semibold">Invoice #{params.quickbooks_invoice_number ?? "-"}</p>
              <p className="text-xs text-[#657086]">Total: {params.invoice_total ?? "-"} • Status: {params.payment_status ?? "-"}</p>
            </div>
          </div>
        </section>
      </div>

      <form id="create-case-form" action={createCaseAction} className="space-y-4">
        <section className="card grid gap-3 border border-[#e7eaef] bg-white p-4 shadow-sm md:grid-cols-2">
          <h2 className="md:col-span-2 text-lg font-semibold text-[#121826]">Customer Details</h2>
          <div>
            <label htmlFor="customer_name" className="label">Customer Name</label>
            <input id="customer_name" name="customer_name" required className="input" defaultValue={params.customer_name ?? ""} placeholder="Enter customer name" />
            <p className="mt-1 text-xs text-[#6b7280]">Primary contact for this service request.</p>
          </div>
          <div>
            <label htmlFor="company_name" className="label">Company Name</label>
            <input id="company_name" name="company_name" className="input" defaultValue={params.company_name ?? ""} placeholder="Enter company name" />
          </div>
          <div>
            <label htmlFor="phone" className="label">Phone</label>
            <input id="phone" name="phone" className="input" defaultValue={params.phone ?? ""} placeholder="Enter phone number" />
          </div>
          <div>
            <label htmlFor="email" className="label">Email</label>
            <input id="email" name="email" type="email" className="input" defaultValue={params.email ?? ""} placeholder="Enter email address" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="shipping_address" className="label">Shipping Address</label>
            <textarea id="shipping_address" name="shipping_address" rows={2} className="textarea" defaultValue={params.shipping_address ?? ""} placeholder="Enter shipping address" />
          </div>
        </section>

        <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
          <section className="card grid gap-3 border border-[#e7eaef] bg-white p-4 shadow-sm md:grid-cols-2">
            <h2 className="md:col-span-2 text-lg font-semibold text-[#121826]">2. Problem and QuickBooks Snapshot</h2>
          <div>
            <label htmlFor="quickbooks_customer_id" className="label">QuickBooks Customer ID</label>
            <input id="quickbooks_customer_id" name="quickbooks_customer_id" className="input" defaultValue={params.quickbooks_customer_id ?? ""} readOnly />
          </div>
          <div>
            <label htmlFor="quickbooks_invoice_id" className="label">QuickBooks Invoice ID</label>
            <input id="quickbooks_invoice_id" name="quickbooks_invoice_id" className="input" defaultValue={params.quickbooks_invoice_id ?? ""} readOnly />
          </div>
          <div>
            <label htmlFor="quickbooks_invoice_number" className="label">QuickBooks Invoice Number</label>
            <input id="quickbooks_invoice_number" name="quickbooks_invoice_number" className="input" defaultValue={params.quickbooks_invoice_number ?? ""} readOnly />
          </div>
          <div>
            <label htmlFor="invoice_date" className="label">Invoice Date</label>
            <input id="invoice_date" name="invoice_date" className="input" defaultValue={params.invoice_date ?? ""} readOnly />
          </div>
          <div>
            <label htmlFor="invoice_total" className="label">Invoice Total</label>
            <input id="invoice_total" name="invoice_total" className="input" defaultValue={params.invoice_total ?? ""} readOnly />
          </div>
          <div>
            <label htmlFor="payment_status" className="label">Payment Status</label>
            <input id="payment_status" name="payment_status" className="input" defaultValue={params.payment_status ?? ""} readOnly />
          </div>
          <div>
            <label htmlFor="date_of_purchase_display" className="label">Date of Purchase</label>
            <input id="date_of_purchase_display" className="input" value={params.invoice_date ?? ""} readOnly placeholder="Auto-filled from QuickBooks invoice" />
            <input type="hidden" name="date_of_purchase" value={params.invoice_date ?? ""} />
          </div>
          <div>
            <label htmlFor="quickbooks_invoice_link" className="label">QuickBooks Invoice Link</label>
            <input id="quickbooks_invoice_link" name="quickbooks_invoice_link" className="input" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="billing_address" className="label">Billing Address</label>
            <textarea id="billing_address" name="billing_address" rows={2} className="textarea" defaultValue={params.billing_address ?? ""} />
          </div>
          </section>

          <section className="card space-y-3 border border-[#e7eaef] bg-white p-4 shadow-sm">
            <h2 className="text-lg font-semibold text-[#121826]">4. Communication</h2>
            <p className="text-xs text-[#5a5a5a]">Timeline entries are generated automatically from actual actions after case creation.</p>
            <div>
              <label htmlFor="internal_notes" className="label">Internal Notes</label>
              <textarea id="internal_notes" name="internal_notes" rows={3} className="textarea" placeholder="What has been done so far?" />
            </div>
            <div>
              <label htmlFor="customer_facing_notes" className="label">Customer-Facing Notes</label>
              <textarea id="customer_facing_notes" name="customer_facing_notes" rows={3} className="textarea" placeholder="What should be shared with customer?" />
            </div>
          </section>
        </div>

        <section className="card grid gap-3 border border-[#e7eaef] bg-white p-4 shadow-sm md:grid-cols-2">
          <h2 className="md:col-span-2 text-lg font-semibold text-[#121826]">3. Resolution Setup</h2>
          <div>
            <label htmlFor="product_model" className="label">Product Model</label>
            <input id="product_model" name="product_model" className="input" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="issue_description" className="label">Issue Description</label>
            <textarea id="issue_description" name="issue_description" rows={4} required className="textarea" placeholder="Describe customer problem, symptoms, and urgency" />
          </div>
        </section>

        <div className="flex items-center justify-between gap-2 rounded-xl border border-[#e7eaef] bg-white p-3 shadow-sm">
          <p className="text-sm text-[#5a5a5a]">Ready to create case? Review required fields and save.</p>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary">Save Case</button>
          <Link href="/cases" className="btn-secondary">Cancel</Link>
          </div>
        </div>
      </form>
    </div>
  );
}
