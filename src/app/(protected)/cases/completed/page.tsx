import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_TYPES, type CaseType } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type CompletedCaseRow = {
  id: string;
  case_number: string;
  case_type: string;
  status: string;
  priority: string;
  updated_at: string;
  closed_at: string | null;
  quickbooks_invoice_number: string | null;
  customers: {
    full_name: string | null;
    company_name: string | null;
  } | null;
};

type Params = {
  q?: string;
  case_type?: string;
};

function normalizeStatusLabel(status: string) {
  if (status === "Completed" || status === "Closed") return "Resolved";
  return status;
}

export default async function CompletedCasesPage({
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
    .select("id, case_number, case_type, status, priority, updated_at, closed_at, quickbooks_invoice_number, customers(full_name, company_name)")
    .in("status", ["Completed", "Closed", "Resolved"])
    .order("updated_at", { ascending: false })
    .limit(250);

  if (params.case_type && CASE_TYPES.includes(params.case_type as (typeof CASE_TYPES)[number])) {
    dbQuery = dbQuery.eq("case_type", params.case_type as CaseType);
  }

  const { data: rows } = await dbQuery;

  const filteredRows = ((rows ?? []) as unknown as CompletedCaseRow[]).filter((row) => {
    if (!query) return true;

    const searchableValues = [
      row.case_number,
      row.customers?.full_name,
      row.customers?.company_name,
      row.quickbooks_invoice_number,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    return searchableValues.some((value) => value.includes(query));
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">Archived and Completed Cases</h1>
          <p className="text-sm text-[#5a5a5a]">Completed cases are retained here and can be reopened from the case detail page.</p>
        </div>
        <Link href="/cases" className="btn-secondary">
          Back to Active Cases
        </Link>
      </div>

      <form className="card grid gap-3 p-4 md:grid-cols-4">
        <div className="md:col-span-2">
          <label htmlFor="q" className="label">Search</label>
          <input id="q" name="q" defaultValue={params.q ?? ""} className="input" placeholder="Case, customer, invoice" />
        </div>
        <div>
          <label htmlFor="case_type" className="label">Case Type</label>
          <select id="case_type" name="case_type" defaultValue={params.case_type ?? ""} className="select">
            <option value="">All</option>
            {CASE_TYPES.map((caseType) => (
              <option key={caseType} value={caseType}>{caseType}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button type="submit" className="btn-primary">Apply</button>
          <Link href="/cases/completed" className="btn-secondary">Clear</Link>
        </div>
      </form>

      <section className="card overflow-x-auto p-4">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#ececec] text-[#5a5a5a]">
              <th className="px-2 py-2">Case</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Customer</th>
              <th className="px-2 py-2">Invoice</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Closed</th>
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
                <td className="px-2 py-2">{row.case_type}</td>
                <td className="px-2 py-2">
                  {row.customers?.full_name}
                  <div className="text-xs text-[#6e6e6e]">{row.customers?.company_name ?? ""}</div>
                </td>
                <td className="px-2 py-2">{row.quickbooks_invoice_number ?? "-"}</td>
                <td className="px-2 py-2">{normalizeStatusLabel(row.status)}</td>
                <td className="px-2 py-2">{row.closed_at ? new Date(row.closed_at).toLocaleString() : "-"}</td>
                <td className="px-2 py-2">{new Date(row.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
