import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { createInstallationAction } from "@/app/(protected)/installation/actions";
import { AttachmentDropzone } from "@/app/(protected)/cases/new/attachment-dropzone";

type SearchParams = {
  error?: string;
  invoice_number?: string;
  customer_name?: string;
  company_name?: string;
  phone?: string;
  email?: string;
  shipping_address?: string;
  quickbooks_customer_id?: string;
  quickbooks_invoice_id?: string;
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

      {params.error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{params.error}</p>
      ) : null}

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
              <input id="customer_name" name="customer_name" required className="input" defaultValue={params.customer_name ?? ""} placeholder="Required" />
            </div>
            <div>
              <label htmlFor="company_name" className="label">Company</label>
              <input id="company_name" name="company_name" className="input" defaultValue={params.company_name ?? ""} />
            </div>
            <div>
              <label htmlFor="phone" className="label">Phone</label>
              <input id="phone" name="phone" className="input" defaultValue={params.phone ?? ""} />
            </div>
            <div>
              <label htmlFor="email" className="label">Email</label>
              <input id="email" name="email" className="input" defaultValue={params.email ?? ""} />
            </div>
            <div>
              <label htmlFor="shipping_address" className="label">Shipping Address</label>
              <input id="shipping_address" name="shipping_address" className="input" defaultValue={params.shipping_address ?? ""} />
            </div>
          </div>
          <input type="hidden" name="quickbooks_invoice_id" value={params.quickbooks_invoice_id ?? ""} />
          <input type="hidden" name="quickbooks_customer_id" value={params.quickbooks_customer_id ?? ""} />
        </section>

        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold text-[#121826]">Installation Summary</h2>
          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="summary" className="label">What was installed?</label>
              <textarea id="summary" name="summary" rows={4} required className="textarea" placeholder="Describe the install, equipment, and any immediate observations." />
            </div>
            <div>
              <label htmlFor="notes" className="label">Notes / log</label>
              <textarea id="notes" name="notes" rows={5} className="textarea" placeholder="Add a simple log entry with time, status, and follow-up actions." />
            </div>
            <div>
              <label htmlFor="status" className="label">Status</label>
              <select id="status" name="status" className="select" defaultValue="New">
                <option value="New">New</option>
                <option value="In Progress">In Progress</option>
                <option value="Completed">Completed</option>
                <option value="Blocked">Blocked</option>
              </select>
            </div>
          </div>
        </section>

        <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
          <h2 className="text-xl font-semibold text-[#121826]">Photos</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">Upload installation photos that will be visible to the team.</p>
          <div className="mt-3">
            <AttachmentDropzone uploadedBy={user.fullName ?? "Unknown"} />
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
