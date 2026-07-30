import Link from "next/link";
import { requireUser } from "@/lib/auth";
import type { CaseStatus } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type DashboardCaseRow = {
  id: string;
  case_number: string;
  status: string;
  priority: string;
  updated_at: string;
  customers: { full_name: string | null; company_name: string | null } | null;
  access_users: { full_name: string | null } | null;
};

async function getCountByStatus(status: CaseStatus) {
  const supabase = getSupabaseAdmin();
  const { count } = await supabase
    .from("customer_service_cases")
    .select("id", { count: "exact", head: true })
    .eq("status", status);

  return count ?? 0;
}

export default async function DashboardPage() {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [{ count: openCases }, { count: highPriority }, { count: recentlyUpdated }, waitingForCustomer, partsNeeded, partsShipped] =
    await Promise.all([
      supabase
        .from("customer_service_cases")
        .select("id", { count: "exact", head: true })
        .not("status", "in", '("Resolved","Closed")'),
      supabase
        .from("customer_service_cases")
        .select("id", { count: "exact", head: true })
        .eq("priority", "High")
        .not("status", "eq", "Closed"),
      supabase
        .from("customer_service_cases")
        .select("id", { count: "exact", head: true })
        .gte("updated_at", sevenDaysAgo.toISOString()),
      getCountByStatus("Waiting for Customer"),
      getCountByStatus("Parts Needed"),
      getCountByStatus("Parts Shipped"),
    ]);

  const { data: latestCases } = await supabase
    .from("customer_service_cases")
    .select(
      `id, case_number, status, priority, updated_at, customers(full_name, company_name), access_users:assigned_employee_id(full_name)`,
    )
    .order("updated_at", { ascending: false })
    .limit(10);

  const cards = [
    { label: "Open Cases", value: openCases ?? 0 },
    { label: "High Priority", value: highPriority ?? 0 },
    { label: "Waiting for Customer", value: waitingForCustomer },
    { label: "Parts Needed", value: partsNeeded },
    { label: "Parts Shipped", value: partsShipped },
    { label: "Updated (7 days)", value: recentlyUpdated ?? 0 },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">Dashboard</h1>
          <p className="text-sm text-[#5a5a5a]">Quick operational view of active service work.</p>
        </div>
        <Link href="/cases/new" className="btn-primary">
          Create New Case
        </Link>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <article key={card.label} className="card p-4">
            <p className="text-sm text-[#5a5a5a]">{card.label}</p>
            <p className="mt-2 text-3xl">{card.value}</p>
          </article>
        ))}
      </section>

      <section className="card p-4">
        <h2 className="text-xl">Recently Updated Cases</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#ebebeb] text-[#5a5a5a]">
                <th className="px-2 py-2">Case</th>
                <th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Priority</th>
                <th className="px-2 py-2">Assigned</th>
                <th className="px-2 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {((latestCases ?? []) as unknown as DashboardCaseRow[]).map((row) => (
                <tr key={row.id} className="border-b border-[#f1f1f1]">
                  <td className="px-2 py-2">
                    <Link href={`/cases/${row.id}`} className="font-semibold text-[#b20610] hover:underline">
                      {row.case_number}
                    </Link>
                  </td>
                  <td className="px-2 py-2">{row.customers?.full_name ?? "-"}</td>
                  <td className="px-2 py-2">{row.status}</td>
                  <td className="px-2 py-2">{row.priority}</td>
                  <td className="px-2 py-2">{row.access_users?.full_name ?? "Unassigned"}</td>
                  <td className="px-2 py-2">{new Date(row.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
