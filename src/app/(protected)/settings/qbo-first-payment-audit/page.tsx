import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import { requireUser } from "@/lib/auth";
import { runQboFirstPaymentAudit } from "@/lib/quickbooks/first-payment-audit";

export default async function QboFirstPaymentAuditPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const user = await requireUser();
  if (!await isAdminUnlockedForUser(user.id)) redirect("/settings?error=Admin+code+required");
  const run = (await searchParams).run === "1";
  if (!run) {
    return <div className="space-y-4"><h1 className="text-3xl">QBO First-Payment Audit</h1><div className="flex gap-2"><Link href="/settings/qbo-first-payment-audit?run=1" className="btn-primary">Run Audit</Link><Link href="/settings" className="btn-secondary">Back</Link></div></div>;
  }

  let audit: Awaited<ReturnType<typeof runQboFirstPaymentAudit>> | null = null;
  let error = "";
  try {
    audit = await runQboFirstPaymentAudit();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Unable to read QBO payment history.";
  }
  if (!audit) return <div className="space-y-4"><h1 className="text-3xl">QBO First-Payment Audit</h1><p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p><Link href="/settings" className="btn-secondary">Back</Link></div>;

  return <div className="space-y-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-3xl">QBO First-Payment Audit</h1><p className="text-sm text-[#5a5a5a]">{audit.generatedAt}</p></div><div className="flex gap-2"><Link href="/settings/qbo-first-payment-backfill" className="btn-primary">Preview Verified Backfill</Link><a href="/settings/qbo-first-payment-audit/export" className="btn-secondary">Export JSON</a><Link href="/settings" className="btn-secondary">Back</Link></div></div><div className="grid gap-3 sm:grid-cols-3"><div className="card p-3"><p className="text-sm text-[#5a5a5a]">Verified</p><p className="text-2xl font-semibold">{audit.summary.verifiedPaymentDates}</p></div><div className="card p-3"><p className="text-sm text-[#5a5a5a]">Unverified</p><p className="text-2xl font-semibold">{audit.summary.unverified}</p></div><div className="card p-3"><p className="text-sm text-[#5a5a5a]">Multiple Payments</p><p className="text-2xl font-semibold">{audit.summary.multiplePaymentTransactions}</p></div></div><section className="card overflow-x-auto p-4"><table className="w-full min-w-[1180px] text-left text-sm"><thead><tr className="border-b"><th>Customer</th><th>Invoice</th><th>SKU</th><th>QBO Status</th><th>ERP First Paid</th><th>Verified First Paid</th><th>Current</th><th>Projected</th><th>Evidence</th></tr></thead><tbody>{audit.rows.map((row) => <tr key={`${row.invoice}-${row.sku}`} className="border-b"><td className="py-2">{row.customer}</td><td>{row.invoice}</td><td>{row.sku ?? "-"}</td><td>{row.qboStatus}</td><td>{row.currentFirstPaymentAt ?? "Not recorded"}</td><td>{row.verifiedFirstPaymentAt ?? "-"}</td><td>#{row.currentQueuePosition}</td><td>#{row.projectedQueuePosition}</td><td>{row.evidenceStatus}</td></tr>)}</tbody></table></section></div>;
}