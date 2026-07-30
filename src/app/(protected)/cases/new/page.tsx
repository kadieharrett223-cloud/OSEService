import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES, PRIORITIES } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createCaseAction } from "@/app/(protected)/cases/actions";

export default async function CreateCasePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const { error } = await searchParams;
  const { data: employees } = await supabase
    .from("access_users")
    .select("id, full_name")
    .eq("is_active", true)
    .order("full_name");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl">Create Customer Service Case</h1>
          <p className="text-sm text-[#5a5a5a]">Phase 1 uses manual QuickBooks references. Sandbox search/link flow is added in Phase 2.</p>
        </div>
        <Link href="/cases" className="btn-secondary">
          Back to Cases
        </Link>
      </div>

      {error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p>
      ) : null}

      <form action={createCaseAction} className="space-y-4">
        <section className="card grid gap-4 p-4 md:grid-cols-2">
          <h2 className="md:col-span-2 text-xl">Customer Information</h2>
          <div>
            <label htmlFor="customer_name" className="label">Customer Name</label>
            <input id="customer_name" name="customer_name" required className="input" />
          </div>
          <div>
            <label htmlFor="company_name" className="label">Company Name</label>
            <input id="company_name" name="company_name" className="input" />
          </div>
          <div>
            <label htmlFor="phone" className="label">Phone</label>
            <input id="phone" name="phone" className="input" />
          </div>
          <div>
            <label htmlFor="email" className="label">Email</label>
            <input id="email" name="email" type="email" className="input" />
          </div>
          <div className="md:col-span-2">
            <label htmlFor="shipping_address" className="label">Shipping Address</label>
            <textarea id="shipping_address" name="shipping_address" rows={2} className="textarea" />
          </div>
        </section>

        <section className="card grid gap-4 p-4 md:grid-cols-2">
          <h2 className="md:col-span-2 text-xl">QuickBooks Link (Phase 1 Manual Reference)</h2>
          <div>
            <label htmlFor="quickbooks_customer_id" className="label">QuickBooks Customer ID</label>
            <input id="quickbooks_customer_id" name="quickbooks_customer_id" className="input" />
          </div>
          <div>
            <label htmlFor="quickbooks_invoice_id" className="label">QuickBooks Invoice ID</label>
            <input id="quickbooks_invoice_id" name="quickbooks_invoice_id" className="input" />
          </div>
          <div>
            <label htmlFor="quickbooks_invoice_number" className="label">QuickBooks Invoice Number</label>
            <input id="quickbooks_invoice_number" name="quickbooks_invoice_number" className="input" />
          </div>
          <div>
            <label htmlFor="quickbooks_invoice_link" className="label">QuickBooks Invoice Link</label>
            <input id="quickbooks_invoice_link" name="quickbooks_invoice_link" className="input" />
          </div>
        </section>

        <section className="card grid gap-4 p-4 md:grid-cols-2">
          <h2 className="md:col-span-2 text-xl">Case Details</h2>
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
            <label htmlFor="assigned_employee_id" className="label">Assigned Employee</label>
            <select id="assigned_employee_id" name="assigned_employee_id" className="select" defaultValue="">
              <option value="">Unassigned</option>
              {(employees ?? []).map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.full_name ?? employee.id}
                </option>
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
