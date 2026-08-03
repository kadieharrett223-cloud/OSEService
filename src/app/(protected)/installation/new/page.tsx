import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createInstallationAction, quickbooksInstallationAutofillAction } from "@/app/(protected)/installation/actions";
import { AttachmentDropzone } from "@/app/(protected)/cases/new/attachment-dropzone";
import { InstallationInvoiceTypeahead } from "@/app/(protected)/installation/invoice-typeahead";

type SearchParams = {
  error?: string;
  prefilled?: string;
  invoice_number?: string;
  customer_name?: string;
  company_name?: string;
  phone?: string;
  email?: string;
  shipping_address?: string;
  quickbooks_customer_id?: string;
  quickbooks_invoice_id?: string;
  quickbooks_invoice_external_id?: string;
  quickbooks_invoice_link?: string;
};

export default async function NewInstallationPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">New Installation</h1>
          <p className="text-sm text-[#5a5a5a]">Collect invoice-driven install details, notes, and photos for the team.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/installation" className="btn-secondary">Cancel</Link>
          <button type="submit" form="installation-form" className="btn-primary">Save Installation</button>
        </div>
      </div>

      {process.env.NODE_ENV !== "production" ? (
        <p className="rounded-md border border-[#e7eaef] bg-[#f8fafc] p-3 text-sm text-[#334155]">
          Sandbox mode is active, so the installation form will work locally even before a full access session is established.
        </p>
      ) : null}

      {params.error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{params.error}</p>
      ) : null}

      {params.prefilled === "1" ? (
        <p className="rounded-md border border-[#b20610] bg-[#fff5f5] p-3 text-sm text-[#8f030d]">
          Invoice match found. Customer and shipping details are prefilled from the invoice.
        </p>
      ) : null}

      <form id="invoice-autofill-form" action={quickbooksInstallationAutofillAction} className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <InstallationInvoiceTypeahead
              initialValue={params.invoice_number ?? ""}
              targetInputId="invoice_number"
              submitFormId="invoice-autofill-form"
              onSelect={() => undefined}
            />
          </div>
          <button type="submit" className="btn-secondary">Find Invoice</button>
        </div>
      </form>

      <form id="installation-form" action={createInstallationAction} className="space-y-4">
        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold text-[#121826]">Invoice & Customer</h2>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div>
              <label htmlFor="invoice_number" className="label">Invoice Number</label>
              <input id="invoice_number" name="invoice_number" required className="input" defaultValue={params.invoice_number ?? ""} placeholder="Required" />
            </div>
            <div>
              <label htmlFor="customer_name" className="label">Customer Name</label>
              <input id="customer_name" name="customer_name" required readOnly={params.prefilled === "1"} className={`input ${params.prefilled === "1" ? "bg-[#f8fafc]" : ""}`} defaultValue={params.customer_name ?? ""} placeholder="Required" />
            </div>
            <div>
              <label htmlFor="company_name" className="label">Company</label>
              <input id="company_name" name="company_name" readOnly={params.prefilled === "1"} className={`input ${params.prefilled === "1" ? "bg-[#f8fafc]" : ""}`} defaultValue={params.company_name ?? ""} />
            </div>
            <div>
              <label htmlFor="phone" className="label">Phone</label>
              <input id="phone" name="phone" readOnly={params.prefilled === "1"} className={`input ${params.prefilled === "1" ? "bg-[#f8fafc]" : ""}`} defaultValue={params.phone ?? ""} />
            </div>
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input id="email" name="email" readOnly={params.prefilled === "1"} className={`input ${params.prefilled === "1" ? "bg-[#f8fafc]" : ""}`} defaultValue={params.email ?? ""} />
            </div>
            <div>
              <label htmlFor="shipping_address" className="label">Shipping Address</label>
              <input id="shipping_address" name="shipping_address" readOnly={params.prefilled === "1"} className={`input ${params.prefilled === "1" ? "bg-[#f8fafc]" : ""}`} defaultValue={params.shipping_address ?? ""} />
            </div>
          </div>
          <input type="hidden" name="quickbooks_invoice_id" value={params.quickbooks_invoice_id ?? ""} />
          <input type="hidden" name="quickbooks_customer_id" value={params.quickbooks_customer_id ?? ""} />
          {params.quickbooks_invoice_link ? (
            <div className="mt-4">
              <a href={params.quickbooks_invoice_link} target="_blank" rel="noreferrer" className="btn-secondary inline-flex">View Invoice</a>
            </div>
          ) : null}
        </section>

        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold text-[#121826]">Photos</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">Upload installation photos that will be visible to the team.</p>
          <div className="mt-3">
            <AttachmentDropzone uploadedBy={user.fullName ?? "Unknown"} />
          </div>
        </section>

        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold text-[#121826]">Notes / Log</h2>
          <div className="mt-4 space-y-3">
            <textarea id="notes" name="notes" rows={6} className="textarea" placeholder="Add a simple log entry with time, status, and follow-up actions." />
            <div>
              <label htmlFor="status" className="label">Status</label>
              <select id="status" name="status" className="select" defaultValue="New Install">
                <option value="New Install">New Install</option>
                <option value="In Progress">In Progress</option>
                <option value="Completed">Completed</option>
                <option value="Blocked">Blocked</option>
              </select>
            </div>
          </div>
        </section>

        <div className="flex items-center justify-between gap-2 rounded-xl border border-[#e7eaef] bg-white p-3 shadow-sm">
          <p className="text-sm text-[#5a5a5a]">The submission will be saved and shared with the team immediately.</p>
          <div className="flex gap-2">
            <button type="submit" className="btn-primary">Save Installation</button>
            <Link href="/installation" className="btn-secondary">Cancel</Link>
          </div>
        </div>
      </form>
    </div>
  );
}
