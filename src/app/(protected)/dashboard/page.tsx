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
  creator: { full_name: string | null } | null;
};

type DashboardParams = {
  status?: string;
};

function statusBadge(status: string) {
  if (status === "Resolved" || status === "Completed" || status === "Closed") return "bg-[#ecfdf3] text-[#166534]";
  if (status === "In Progress") return "bg-[#fff1f2] text-[#be123c]";
  if (status === "New") return "bg-[#ecfdf3] text-[#166534]";
  if (status === "Waiting for Customer") return "bg-[#fff7ed] text-[#c2410c]";
  if (status.includes("Parts")) return "bg-[#eff6ff] text-[#1d4ed8]";
  return "bg-[#f3f4f6] text-[#374151]";
}

function priorityBadge(priority: string) {
  if (priority === "High") return "bg-[#fff1f2] text-[#be123c]";
  if (priority === "Medium") return "bg-[#fff7ed] text-[#c2410c]";
  return "bg-[#ecfeff] text-[#155e75]";
}

function isResolvedStatus(status: string) {
  return status === "Resolved" || status === "Completed" || status === "Closed";
}

function formatRelative(dateIso: string) {
  const deltaMs = Date.now() - new Date(dateIso).getTime();
  const hours = Math.floor(deltaMs / (1000 * 60 * 60));
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

async function getCaseSummaryRows() {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("customer_service_cases")
    .select("id, status, priority, updated_at")
    .order("updated_at", { ascending: false });

  return ((data ?? []) as Array<{ id: string; status: string; priority: string; updated_at: string }>);
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardParams>;
}) {
  await requireUser();
  const params = await searchParams;
  const supabase = getSupabaseAdmin();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const statusFilter = params.status === "resolved"
    ? "resolved"
    : params.status === "in-progress"
      ? "in-progress"
      : "all";

  const [caseRows, { count: recentlyUpdated }] = await Promise.all([
    getCaseSummaryRows(),
    supabase
      .from("customer_service_cases")
      .select("id", { count: "exact", head: true })
      .gte("updated_at", sevenDaysAgo.toISOString()),
  ]);

  const openCases = caseRows.filter((row) => !isResolvedStatus(row.status)).length;
  const highPriority = caseRows.filter((row) => row.priority === "High" && !isResolvedStatus(row.status)).length;
  const waitingForCustomer = caseRows.filter((row) => row.status === "Waiting for Customer").length;
  const partsNeeded = caseRows.filter((row) => row.status === "Parts Needed").length;
  const partsShipped = caseRows.filter((row) => row.status === "Parts Shipped").length;

  let latestCasesQuery = supabase
    .from("customer_service_cases")
    .select(
      `id, case_number, status, priority, updated_at, customers(full_name, company_name), access_users:assigned_employee_id(full_name), creator:created_by(full_name)`,
    )
    .order("updated_at", { ascending: false })
    .limit(10);

  if (statusFilter === "in-progress") {
    latestCasesQuery = latestCasesQuery.eq("status", "In Progress");
  }

  if (statusFilter === "resolved") {
    latestCasesQuery = latestCasesQuery.in("status", ["Resolved", "Completed", "Closed"]);
  }

  const { data: latestCases } = await latestCasesQuery;

  const cards = [
    { label: "Open Cases", icon: "📋", value: openCases ?? 0, trend: `${recentlyUpdated ?? 0} updated this week`, action: { href: "/cases", label: "View Cases" } },
    { label: "High Priority", icon: "⚠", value: highPriority ?? 0, trend: highPriority ? "Needs immediate review" : "No critical cases", action: { href: "/cases?priority=High", label: "Review" } },
    { label: "Waiting Customer", icon: "💬", value: waitingForCustomer, trend: waitingForCustomer ? "Pending customer response" : "No customer blockers", action: { href: "/cases?status=Waiting%20for%20Customer", label: "Open" } },
    { label: "Parts Needed", icon: "🧰", value: partsNeeded, trend: partsNeeded ? "Coordinate procurement" : "No parts needed", action: { href: "/cases?status=Parts%20Needed", label: "Track" } },
    { label: "Parts Shipped", icon: "🚚", value: partsShipped, trend: partsShipped ? "In transit to customer" : "No shipments active", action: { href: "/cases?status=Parts%20Shipped", label: "View" } },
    { label: "Updated (7 days)", icon: "🕒", value: recentlyUpdated ?? 0, trend: "Recent operational activity", action: { href: "/cases", label: "Inspect" } },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl text-[#111827]">Dashboard</h1>
          <p className="text-sm text-[#6b7280]">Operational overview for active service workflow.</p>
        </div>
        <Link href="/cases/new" className="btn-primary">
          Create New Case
        </Link>
      </div>

      <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
        {cards.map((card) => (
          <article key={card.label} className="card p-3 hover:shadow-md">
            <div className="flex items-center justify-between">
              <p className="text-xs text-[#6b7280]">{card.label}</p>
              <span className="text-sm">{card.icon}</span>
            </div>
            <p className="mt-1 text-3xl font-semibold text-[#111827]">{card.value}</p>
            <p className="mt-1 text-xs text-[#6b7280]">{card.trend}</p>
            <Link href={card.action.href} className="mt-2 inline-flex text-xs font-medium text-[#d50917] hover:underline">
              {card.action.label} →
            </Link>
          </article>
        ))}
      </section>

      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-[#111827]">Recently Updated Cases</h2>
          <div className="flex gap-1">
            <Link
              href="/dashboard"
              className={`rounded-md px-2 py-1 text-xs font-semibold ${statusFilter === "all" ? "bg-[#1f2937] text-white" : "bg-[#eef2f7] text-[#334155]"}`}
            >
              All
            </Link>
            <Link
              href="/dashboard?status=in-progress"
              className={`rounded-md px-2 py-1 text-xs font-semibold ${statusFilter === "in-progress" ? "bg-[#be123c] text-white" : "bg-[#fff1f2] text-[#be123c]"}`}
            >
              In Progress
            </Link>
            <Link
              href="/dashboard?status=resolved"
              className={`rounded-md px-2 py-1 text-xs font-semibold ${statusFilter === "resolved" ? "bg-[#166534] text-white" : "bg-[#ecfdf3] text-[#166534]"}`}
            >
              Resolved
            </Link>
          </div>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#ebebeb] text-xs uppercase tracking-[0.06em] text-[#6b7280]">
                <th className="px-2 py-2">Case</th>
                <th className="px-2 py-2">Customer</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Priority</th>
                <th className="px-2 py-2">Assigned</th>
                <th className="px-2 py-2">Created by</th>
                <th className="px-2 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {((latestCases ?? []) as unknown as DashboardCaseRow[]).length ? (
                ((latestCases ?? []) as unknown as DashboardCaseRow[]).map((row) => (
                  <tr key={row.id} className="border-b border-[#f1f1f1] hover:bg-[#f8fafc]">
                    <td className="px-2 py-2">
                      <Link href={`/cases/${row.id}`} className="font-semibold text-[#b20610] hover:underline">
                        {row.case_number}
                      </Link>
                    </td>
                    <td className="px-2 py-2">
                      <p className="font-medium text-[#1f2937]">{row.customers?.full_name ?? "Unknown"}</p>
                      <p className="text-xs text-[#6b7280]">{row.customers?.company_name ?? "No company"}</p>
                    </td>
                    <td className="px-2 py-2">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(row.status)}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          isResolvedStatus(row.status) ? "bg-[#ecfdf3] text-[#166534]" : priorityBadge(row.priority)
                        }`}
                      >
                        {isResolvedStatus(row.status) ? "Complete" : row.priority}
                      </span>
                    </td>
                    <td className="px-2 py-2">{row.access_users?.full_name ?? "Unassigned"}</td>
                    <td className="px-2 py-2">{row.creator?.full_name ?? "Unknown"}</td>
                    <td className="px-2 py-2 text-[#6b7280]">{formatRelative(row.updated_at)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="px-2 py-10 text-center">
                    <div className="mx-auto max-w-sm space-y-2">
                      <p className="text-3xl">📂</p>
                      <p className="text-sm font-medium text-[#111827]">No active service cases.</p>
                      <p className="text-sm text-[#6b7280]">Create your first case to start tracking service workflow.</p>
                      <Link href="/cases/new" className="btn-primary inline-flex">
                        Create First Case
                      </Link>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
