import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES, PRIORITIES } from "@/lib/constants";
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
  }>;
}) {
  await requireUser();

  const params = await searchParams;
  const error = params.error;
  const enteredDate = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl">Create Customer Service Case</h1>
          <p className="text-sm text-[#5a5a5a]">Use QuickBooks snapshot data to quickly pull customer and invoice details into this intake document.</p>
        </div>
        <Link href="/cases" className="btn-secondary">
          Back to Cases
        </Link>
      </div>

      {error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p>
      ) : null}

      {params.prefilled === "1" ? (
        <p className="rounded-md border border-[#badfbe] bg-[#f4fff5] p-3 text-sm text-[#1f6f27]">
          QuickBooks match found. Review and adjust any fields before saving.
        </p>
      ) : null}

      <section className="card space-y-3 border-l-4 border-l-[#8b6a43] bg-[#fffefb] p-4">
        <div>
          <h2 className="text-xl">QuickBooks Autofill</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">
            Start typing a customer name, customer ID, or invoice number to see matches.
          </p>
        </div>
        <form action={quickbooksAutofillAction} className="space-y-2">
          <QuickbooksLookup />
          <div className="flex justify-end">
            <button type="submit" className="btn-secondary">Find and Prefill</button>
          </div>
        </form>
      </section>

      <form action={createCaseAction} className="space-y-4">
        <section className="card grid gap-4 border-l-4 border-l-[#27445d] bg-[#fffefb] p-4 md:grid-cols-2">
          <h2 className="md:col-span-2 text-xl">Customer Information</h2>
          <div>
            <label htmlFor="customer_name" className="label">Customer Name</label>
            <input id="customer_name" name="customer_name" required className="input" defaultValue={params.customer_name ?? ""} />
          </div>
          <div>
            <label htmlFor="company_name" className="label">Company Name</label>
            <input id="company_name" name="company_name" className="input" defaultValue={params.company_name ?? ""} />
          </div>
          <div>
            <label htmlFor="phone" className="label">Phone</label>
            <input id="phone" name="phone" className="input" defaultValue={params.phone ?? ""} />
          </div>
          <div>
            <label htmlFor="email" className="label">Email</label>
            <input id="email" name="email" type="email" className="input" defaultValue={params.email ?? ""} />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="shipping_address" className="label">Shipping Address</label>
            <textarea id="shipping_address" name="shipping_address" rows={2} className="textarea" defaultValue={params.shipping_address ?? ""} />
          </div>
        </section>

        <section className="card grid gap-4 border-l-4 border-l-[#4b7a4d] bg-[#fffefb] p-4 md:grid-cols-2">
          <h2 className="md:col-span-2 text-xl">QuickBooks Invoice Snapshot</h2>
          <div>
            <label htmlFor="quickbooks_customer_id" className="label">QuickBooks Customer ID</label>
            <input id="quickbooks_customer_id" name="quickbooks_customer_id" className="input" defaultValue={params.quickbooks_customer_id ?? ""} />
          </div>
          <div>
            <label htmlFor="quickbooks_invoice_id" className="label">QuickBooks Invoice ID</label>
            <input id="quickbooks_invoice_id" name="quickbooks_invoice_id" className="input" defaultValue={params.quickbooks_invoice_id ?? ""} />
          </div>
          <div>
            <label htmlFor="quickbooks_invoice_number" className="label">QuickBooks Invoice Number</label>
            <input id="quickbooks_invoice_number" name="quickbooks_invoice_number" className="input" defaultValue={params.quickbooks_invoice_number ?? ""} />
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
            <label htmlFor="quickbooks_invoice_link" className="label">QuickBooks Invoice Link</label>
            <input id="quickbooks_invoice_link" name="quickbooks_invoice_link" className="input" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="billing_address" className="label">Billing Address</label>
            <textarea id="billing_address" name="billing_address" rows={2} className="textarea" defaultValue={params.billing_address ?? ""} />
          </div>
        </section>

        <section className="card grid gap-4 border-l-4 border-l-[#7b3f00] bg-[#fffefb] p-4 md:grid-cols-2">
          <h2 className="md:col-span-2 text-xl">Case Details</h2>
          <div>
            <label htmlFor="entered_date" className="label">Enter Date</label>
            <input id="entered_date" name="entered_date" type="date" className="input" defaultValue={enteredDate} />
          </div>
          <div>
            <label htmlFor="product_model" className="label">Product Model</label>
            <input id="product_model" name="product_model" className="input" />
          </div>
          <div>
            <label htmlFor="serial_number" className="label">Serial Number</label>
            <input id="serial_number" name="serial_number" className="input" />
          </div>
          <div>
            <label htmlFor="date_of_purchase" className="label">Date of Purchase</label>
            <input id="date_of_purchase" name="date_of_purchase" type="date" className="input" />
          </div>
          <div>
            <label htmlFor="issue_reported_at" className="label">Issue Reported Date</label>
            <input id="issue_reported_at" name="issue_reported_at" type="datetime-local" className="input" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="issue_description" className="label">Issue Description</label>
            <textarea id="issue_description" name="issue_description" rows={4} required className="textarea" />
          </div>
          <div>
            <label htmlFor="priority" className="label">Priority</label>
            <select id="priority" name="priority" className="select" defaultValue="Medium">
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>{priority}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="status" className="label">Status</label>
            <select id="status" name="status" className="select" defaultValue="New">
              {CASE_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label htmlFor="internal_notes" className="label">Internal Notes</label>
            <textarea id="internal_notes" name="internal_notes" rows={3} className="textarea" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="customer_facing_notes" className="label">Customer-Facing Notes</label>
            <textarea id="customer_facing_notes" name="customer_facing_notes" rows={3} className="textarea" />
          </div>
        </section>

        <div className="flex gap-2">
          <button type="submit" className="btn-primary">Save Case</button>
          <Link href="/cases" className="btn-secondary">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
