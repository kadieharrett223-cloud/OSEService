import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  CASE_STATUSES,
  CASE_TYPES,
  PRIORITIES,
  type CasePriority,
  type CaseStatus,
  type CaseType,
} from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type CaseListRow = {
  id: string;
  case_number: string;
  case_type: string;
  status: string;
  priority: string;
  updated_at: string;
  quickbooks_invoice_number: string | null;
  product_model: string | null;
  serial_number: string | null;
  customers: {
    full_name: string | null;
    company_name: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  assigned: { full_name: string | null } | null;
};

type Params = {
  q?: string;
  status?: string;
  priority?: string;
  employee?: string;
  case_type?: string;
};

export default async function CasesPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  await requireUser();
  const params = await searchParams;
  const supabase = getSupabaseAdmin();

  const query = (params.q ?? "").trim().toLowerCase();

  let dbQuery = supabase
    .from("customer_service_cases")
    .select(
      `id, case_number, case_type, status, priority, updated_at, quickbooks_invoice_number, product_model, serial_number,
       customers(full_name, company_name, phone, email),
       assigned:access_users!customer_service_cases_assigned_employee_id_access_user_fkey(full_name)`,
    )
    .order("updated_at", { ascending: false })
    .limit(250);

  if (params.status && CASE_STATUSES.includes(params.status as (typeof CASE_STATUSES)[number])) {
    dbQuery = dbQuery.eq("status", params.status as CaseStatus);
  } else {
    dbQuery = dbQuery.not("status", "in", "(Completed,Resolved,Closed)");
  }

  if (params.priority && PRIORITIES.includes(params.priority as (typeof PRIORITIES)[number])) {
    dbQuery = dbQuery.eq("priority", params.priority as CasePriority);
  }

  if (params.employee) {
    dbQuery = dbQuery.eq("assigned_employee_id", params.employee);
  }

  if (params.case_type && CASE_TYPES.includes(params.case_type as (typeof CASE_TYPES)[number])) {
    dbQuery = dbQuery.eq("case_type", params.case_type as CaseType);
  }

  const [{ data: rows }, { data: employees }] = await Promise.all([
    dbQuery,
    supabase.from("access_users").select("id, full_name").eq("is_active", true).order("full_name"),
  ]);

  const filteredRows = ((rows ?? []) as unknown as CaseListRow[]).filter((row) => {
    if (!query) return true;

    const searchableValues = [
      row.case_number,
      row.customers?.full_name,
      row.customers?.company_name,
      row.customers?.phone,
      row.customers?.email,
      row.quickbooks_invoice_number,
      row.product_model,
      row.serial_number,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    return searchableValues.some((value) => value.includes(query));
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">Customer and Case List</h1>
          <p className="text-sm text-[#5a5a5a]">Search active cases by customer, invoice, model, tracking context, and ownership.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/cases/completed" className="btn-secondary">
            Archived / Completed
          </Link>
          <Link href="/cases/new" className="btn-primary">
            Create Case
          </Link>
        </div>
      </div>

      <form className="card grid gap-3 p-4 md:grid-cols-6">
        <div className="md:col-span-2">
          <label htmlFor="q" className="label">
            Search
          </label>
          <input id="q" name="q" defaultValue={params.q ?? ""} className="input" placeholder="Name, phone, email, invoice, model" />
        </div>

        <div>
          <label htmlFor="status" className="label">
            Status
          </label>
          <select id="status" name="status" defaultValue={params.status ?? ""} className="select">
            <option value="">All</option>
            {CASE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="priority" className="label">
            Priority
          </label>
          <select id="priority" name="priority" defaultValue={params.priority ?? ""} className="select">
            <option value="">All</option>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="employee" className="label">
            Assigned Employee
          </label>
          <select id="employee" name="employee" defaultValue={params.employee ?? ""} className="select">
            <option value="">All</option>
            {(employees ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.full_name ?? employee.id}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="case_type" className="label">
            Case Type
          </label>
          <select id="case_type" name="case_type" defaultValue={params.case_type ?? ""} className="select">
            <option value="">All</option>
            {CASE_TYPES.map((caseType) => (
              <option key={caseType} value={caseType}>
                {caseType}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-6 flex gap-2">
          <button type="submit" className="btn-primary">
            Apply Filters
          </button>
          <Link href="/cases" className="btn-secondary">
            Clear
          </Link>
        </div>
      </form>

      <section className="card overflow-x-auto p-4">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#ececec] text-[#5a5a5a]">
              <th className="px-2 py-2">Case</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Customer</th>
              <th className="px-2 py-2">Invoice</th>
              <th className="px-2 py-2">Product</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Priority</th>
              <th className="px-2 py-2">Assigned</th>
              <th className="px-2 py-2">Updated</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.id} className="border-b border-[#f2f2f2]">
                <td className="px-2 py-2">
                  <Link href={`/cases/${row.id}`} className="font-semibold text-[#b20610] hover:underline">
                    {row.case_number}
                  </Link>
                </td>
                <td className="px-2 py-2">{row.case_type ?? "General"}</td>
                <td className="px-2 py-2">
                  {row.customers?.full_name}
                  <div className="text-xs text-[#6e6e6e]">{row.customers?.company_name ?? ""}</div>
                </td>
                <td className="px-2 py-2">{row.quickbooks_invoice_number ?? "-"}</td>
                <td className="px-2 py-2">{row.product_model ?? "-"}</td>
                <td className="px-2 py-2">{row.status}</td>
                <td className="px-2 py-2">
                  <span className={`badge ${row.priority === "High" ? "badge-priority-high" : "badge-status"}`}>{row.priority}</span>
                </td>
                <td className="px-2 py-2">{row.assigned?.full_name ?? "Unassigned"}</td>
                <td className="px-2 py-2">{new Date(row.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
