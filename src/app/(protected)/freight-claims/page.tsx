import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES, PRIORITIES } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type FreightClaimRow = {
  id: string;
  case_number: string;
  case_type: string;
  status: string;
  priority: string;
  updated_at: string;
  issue_description: string;
  product_model: string | null;
  serial_number: string | null;
  quickbooks_invoice_number: string | null;
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
  sort?: string;
};

function statusBadge(status: string) {
  if (status === "Resolved" || status === "Completed" || status === "Closed") return "bg-[#ecfdf3] text-[#166534]";
  if (status === "In Progress") return "bg-[#fff1f2] text-[#be123c]";
  if (status === "New") return "bg-[#ecfdf3] text-[#166534]";
  if (status === "Waiting for Customer") return "bg-[#fff7ed] text-[#c2410c]";
  if (status.includes("Parts")) return "bg-[#eff6ff] text-[#1d4ed8]";
  return "bg-[#f3f4f6] text-[#374151]";
}

function isResolvedStatus(status: string) {
  return status === "Resolved" || status === "Completed" || status === "Closed";
}

function summarizeIssue(issueDescription: string) {
  const trimmed = issueDescription.trim();
  if (trimmed.length <= 120) return trimmed;
  return `${trimmed.slice(0, 117)}...`;
}

export default async function FreightClaimsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  await requireUser();
  const params = await searchParams;
  const supabase = getSupabaseAdmin();
  const query = (params.q ?? "").trim().toLowerCase();
  const sort = params.sort ?? "updated_desc";
  const freightCaseType = "Freight Damage";

  let dbQuery = supabase
    .from("customer_service_cases")
    .select(
      `id, case_number, case_type, status, priority, updated_at, issue_description, product_model, serial_number, quickbooks_invoice_number,
       customers(full_name, company_name, phone, email),
       assigned:access_users!customer_service_cases_assigned_employee_id_access_user_fkey(full_name)`
    )
    .eq("case_type", freightCaseType)
    .order("updated_at", { ascending: false })
    .limit(250);

  if (params.status && CASE_STATUSES.includes(params.status as (typeof CASE_STATUSES)[number])) {
    dbQuery = dbQuery.eq("status", params.status as (typeof CASE_STATUSES)[number]);
  }

  if (params.priority && PRIORITIES.includes(params.priority as (typeof PRIORITIES)[number])) {
    dbQuery = dbQuery.eq("priority", params.priority as (typeof PRIORITIES)[number]);
  }

  if (params.employee) {
    dbQuery = dbQuery.eq("assigned_employee_id", params.employee);
  }

  const [{ data: rows }, { data: employees }, { data: summaryRows }, { count: recentlyUpdated }] = await Promise.all([
    dbQuery,
    supabase.from("access_users").select("id, full_name").eq("is_active", true).order("full_name"),
    supabase
      .from("customer_service_cases")
      .select("id, status, priority, updated_at")
      .eq("case_type", freightCaseType),
    supabase
      .from("customer_service_cases")
      .select("id", { count: "exact", head: true })
      .eq("case_type", freightCaseType)
      .gte("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
  ]);

  const freightRows = (summaryRows ?? []) as Array<{ id: string; status: string; priority: string; updated_at: string }>;
  const openClaims = freightRows.filter((row) => !isResolvedStatus(row.status)).length;
  const highPriorityClaims = freightRows.filter((row) => row.priority === "High" && !isResolvedStatus(row.status)).length;
  const waitingCustomerClaims = freightRows.filter((row) => row.status === "Waiting for Customer").length;
  const inProgressClaims = freightRows.filter((row) => row.status === "In Progress").length;
  const resolvedClaims = freightRows.filter((row) => isResolvedStatus(row.status)).length;

  const filteredRows = ((rows ?? []) as unknown as FreightClaimRow[]).filter((row) => {
    const shouldHideCompletedByDefault = !params.status && !params.priority && !params.employee && !query;
    if (shouldHideCompletedByDefault && isResolvedStatus(row.status)) {
      return false;
    }

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
      row.issue_description,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    return searchableValues.some((value) => value.includes(query));
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    if (sort === "updated_asc") {
      return new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime();
    }

    if (sort === "priority_desc") {
      const rank: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
      const diff = (rank[a.priority] ?? 99) - (rank[b.priority] ?? 99);
      if (diff !== 0) return diff;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    }

    if (sort === "status_asc") {
      const statusDiff = a.status.localeCompare(b.status);
      if (statusDiff !== 0) return statusDiff;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    }

    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">Freight Claim List</h1>
          <p className="text-sm text-[#5a5a5a]">Track freight damage claims in the same workflow used for service cases.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/cases/new?case_type=Freight%20Damage" className="btn-primary">
            Create Freight Claim
          </Link>
          <Link href="/cases" className="btn-secondary">
            Cases
          </Link>
        </div>
      </div>

      <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
        <article className="card p-3">
          <p className="text-xs text-[#6b7280]">Open Claims</p>
          <p className="mt-1 text-3xl font-semibold text-[#111827]">{openClaims}</p>
          <Link href="/freight-claims" className="mt-2 inline-flex text-xs font-medium text-[#d50917] hover:underline">View →</Link>
        </article>
        <article className="card p-3">
          <p className="text-xs text-[#6b7280]">High Priority</p>
          <p className="mt-1 text-3xl font-semibold text-[#111827]">{highPriorityClaims}</p>
          <Link href="/freight-claims?priority=High" className="mt-2 inline-flex text-xs font-medium text-[#d50917] hover:underline">Review →</Link>
        </article>
        <article className="card p-3">
          <p className="text-xs text-[#6b7280]">Waiting Customer</p>
          <p className="mt-1 text-3xl font-semibold text-[#111827]">{waitingCustomerClaims}</p>
          <Link href="/freight-claims?status=Waiting%20for%20Customer" className="mt-2 inline-flex text-xs font-medium text-[#d50917] hover:underline">Open →</Link>
        </article>
        <article className="card p-3">
          <p className="text-xs text-[#6b7280]">In Progress</p>
          <p className="mt-1 text-3xl font-semibold text-[#111827]">{inProgressClaims}</p>
          <Link href="/freight-claims?status=In%20Progress" className="mt-2 inline-flex text-xs font-medium text-[#d50917] hover:underline">Track →</Link>
        </article>
        <article className="card p-3">
          <p className="text-xs text-[#6b7280]">Resolved</p>
          <p className="mt-1 text-3xl font-semibold text-[#111827]">{resolvedClaims}</p>
          <Link href="/freight-claims?status=Resolved" className="mt-2 inline-flex text-xs font-medium text-[#d50917] hover:underline">Review →</Link>
        </article>
        <article className="card p-3">
          <p className="text-xs text-[#6b7280]">Updated (7 days)</p>
          <p className="mt-1 text-3xl font-semibold text-[#111827]">{recentlyUpdated ?? 0}</p>
          <Link href="/freight-claims" className="mt-2 inline-flex text-xs font-medium text-[#d50917] hover:underline">Inspect →</Link>
        </article>
      </section>

      <form className="card grid gap-3 p-3 md:grid-cols-7">
        <div className="md:col-span-2">
          <label htmlFor="q" className="label">Search</label>
          <input id="q" name="q" defaultValue={params.q ?? ""} className="input" placeholder="Case, customer, invoice, product, serial" />
        </div>

        <div>
          <label htmlFor="status" className="label">Status</label>
          <select id="status" name="status" defaultValue={params.status ?? ""} className="select">
            <option value="">All</option>
            {CASE_STATUSES.map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="priority" className="label">Priority</label>
          <select id="priority" name="priority" defaultValue={params.priority ?? ""} className="select">
            <option value="">All</option>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>{priority}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="employee" className="label">Assigned Employee</label>
          <select id="employee" name="employee" defaultValue={params.employee ?? ""} className="select">
            <option value="">All</option>
            {(employees ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>{employee.full_name ?? employee.id}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="sort" className="label">Sort</label>
          <select id="sort" name="sort" defaultValue={sort} className="select">
            <option value="updated_desc">Updated (Newest)</option>
            <option value="updated_asc">Updated (Oldest)</option>
            <option value="priority_desc">Priority (High to Low)</option>
            <option value="status_asc">Status (A to Z)</option>
          </select>
        </div>

        <div className="md:col-span-7 flex gap-2">
          <button type="submit" className="btn-secondary">Apply Filters</button>
          <Link href="/freight-claims" className="btn-ghost">Clear</Link>
        </div>
      </form>

      <section className="card overflow-x-auto p-4">
        <table className="w-full min-w-[1000px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#ececec] text-[#5a5a5a]">
              <th className="px-2 py-2">Claim</th>
              <th className="px-2 py-2">Customer</th>
              <th className="px-2 py-2">Invoice</th>
              <th className="px-2 py-2">Product</th>
              <th className="px-2 py-2">Issue</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Priority</th>
              <th className="px-2 py-2">Assigned</th>
              <th className="px-2 py-2">Updated</th>
              <th className="px-2 py-2 text-right">Open</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length ? (
              sortedRows.map((row) => (
                <tr key={row.id} className="border-b border-[#f2f2f2] hover:bg-[#f8fafc]">
                  <td className="px-2 py-2">
                    <Link href={`/cases/${row.id}`} className="font-semibold text-[#b20610] hover:underline">{row.case_number}</Link>
                    <div className="text-xs text-[#6e6e6e]">Freight Damage</div>
                  </td>
                  <td className="px-2 py-2">
                    {row.customers?.full_name}
                    <div className="text-xs text-[#6e6e6e]">{row.customers?.company_name ?? ""}</div>
                  </td>
                  <td className="px-2 py-2">{row.quickbooks_invoice_number ?? "-"}</td>
                  <td className="px-2 py-2">
                    {row.product_model ?? "-"}
                    <div className="text-xs text-[#6e6e6e]">{row.serial_number ?? ""}</div>
                  </td>
                  <td className="px-2 py-2 text-[#374151]">{summarizeIssue(row.issue_description)}</td>
                  <td className="px-2 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(row.status)}`}>{row.status}</span>
                  </td>
                  <td className="px-2 py-2">
                    <span className={`badge ${row.priority === "High" ? "badge-priority-high" : "badge-status"}`}>{row.priority}</span>
                  </td>
                  <td className="px-2 py-2">{row.assigned?.full_name ?? "Unassigned"}</td>
                  <td className="px-2 py-2">{new Date(row.updated_at).toLocaleString()}</td>
                  <td className="px-2 py-2 text-right">
                    <Link href={`/cases/${row.id}`} className="btn-secondary text-xs">Open</Link>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={10} className="px-2 py-10 text-center">
                  <p className="text-3xl">📦</p>
                  <p className="mt-2 text-sm font-medium text-[#111827]">No freight claims found.</p>
                  <p className="text-sm text-[#6b7280]">Create the first freight damage case to start tracking claims.</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
