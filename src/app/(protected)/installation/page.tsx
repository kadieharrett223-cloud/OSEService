import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type InstallationJobRow = {
  id: string;
  invoice_number: string;
  customer_name: string;
  company_name: string | null;
  status: string;
  summary: string;
  created_at: string;
  updated_at: string;
};

export default async function InstallationPage() {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const { data: rows } = await supabase
    .from("installation_jobs")
    .select("id, invoice_number, customer_name, company_name, status, summary, created_at, updated_at")
    .order("created_at", { ascending: false });

  const installationRows = (rows ?? []) as InstallationJobRow[];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">Installation Jobs</h1>
          <p className="text-sm text-[#5a5a5a]">Track installer submissions, notes, and photos for every job in one place.</p>
        </div>
        <Link href="/installation/new" className="btn-primary">
          New Installation
        </Link>
      </div>

      <section className="card overflow-x-auto p-4">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#ececec] text-[#5a5a5a]">
              <th className="px-2 py-2">Invoice</th>
              <th className="px-2 py-2">Customer</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Summary</th>
              <th className="px-2 py-2">Created</th>
              <th className="px-2 py-2 text-right">Open</th>
            </tr>
          </thead>
          <tbody>
            {installationRows.length ? (
              installationRows.map((row) => (
                <tr key={row.id} className="border-b border-[#f2f2f2] hover:bg-[#f8fafc]">
                  <td className="px-2 py-2 font-semibold text-[#b20610]">{row.invoice_number}</td>
                  <td className="px-2 py-2">
                    <div className="font-semibold text-[#121826]">{row.customer_name}</div>
                    {row.company_name ? <div className="text-xs text-[#64748b]">{row.company_name}</div> : null}
                  </td>
                  <td className="px-2 py-2">{row.status}</td>
                  <td className="px-2 py-2 text-[#334155]">{row.summary}</td>
                  <td className="px-2 py-2 text-[#64748b]">{new Date(row.created_at).toLocaleString()}</td>
                  <td className="px-2 py-2 text-right">
                    <Link href={`/installation/${row.id}`} className="font-semibold text-[#b20610] hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-[#64748b]">
                  No installation jobs yet. Create the first one to begin tracking.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
