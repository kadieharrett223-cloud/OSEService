import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import { requireUser } from "@/lib/auth";
import { previewInvoiceDateFallbackQueue } from "@/lib/demand/invoice-date-fallback-preview";

export default async function QueuePriorityPreviewPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const user = await requireUser();
  if (!await isAdminUnlockedForUser(user.id)) redirect("/settings?error=Admin+code+required");
  if ((await searchParams).run !== "1") return <div className="space-y-4"><h1 className="text-3xl">Invoice-Date Queue Priority Preview</h1><p className="text-sm text-[#5a5a5a]">Read-only. Compares first-payment-or-created ordering against the shared invoice-date fallback.</p><div className="flex gap-2"><Link href="/settings/queue-priority-preview?run=1" className="btn-primary">Run Preview</Link><Link href="/settings" className="btn-secondary">Back</Link></div></div>;
  const preview = await previewInvoiceDateFallbackQueue();
  return <div className="space-y-5"><div><h1 className="text-3xl">Invoice-Date Queue Priority Preview</h1><p className="text-sm text-[#5a5a5a]">Read-only comparison generated {preview.generatedAt}.</p></div><div className="grid gap-3 sm:grid-cols-2"><div className="card p-3"><p className="text-sm text-[#5a5a5a]">Active Canonical Rows</p><p className="text-2xl font-semibold">{preview.activeCanonicalRows}</p></div><div className="card p-3"><p className="text-sm text-[#5a5a5a]">Position Changes</p><p className="text-2xl font-semibold">{preview.changedRows}</p></div></div><section className="card overflow-x-auto p-4"><table className="w-full min-w-[1080px] text-left text-sm"><thead><tr className="border-b"><th>Customer</th><th>Invoice</th><th>SKU</th><th>First Paid</th><th>Invoice Date</th><th>Previous</th><th>Invoice-Date Fallback</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={`${row.sku}-${row.invoice}`} className="border-b"><td className="py-2">{row.customer}</td><td>{row.invoice}</td><td>{row.sku ?? "-"}</td><td>{row.firstPaymentAt ?? "Not recorded"}</td><td>{row.invoiceDate ?? "Unavailable"}</td><td>#{row.previousPosition}</td><td>#{row.fallbackPosition}</td></tr>)}</tbody></table></section><Link href="/settings" className="btn-secondary">Back</Link></div>;
}