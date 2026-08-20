import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { evaluateOrderHealth, type HealthLine, type OrderHealthIssue } from "@/lib/orders/order-health";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type OrderRow = {
  id: string;
  order_number: string | null;
  cancellation_status?: string | null;
  customers?: { company_name: string | null; full_name: string | null } | null;
  qbo_invoices?: { invoice_number: string | null; raw_payload?: { PrivateNote?: string | null } | null } | null;
  shipping_order_lines?: HealthLine[];
};

function severityClass(severity: string) {
  if (severity === "ERROR") return "bg-[#fee2e2] text-[#b91c1c]";
  if (severity === "WARNING") return "bg-[#fff7e6] text-[#92400e]";
  return "bg-[#eef2f7] text-[#475569]";
}

export default async function ExceptionsPage() {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const baseSelect = "id,order_number,customers(company_name,full_name),qbo_invoices(invoice_number,raw_payload),shipping_order_lines(id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,queue_position_start,queue_position_count,products(sku,canonical_name),inventory_allocations(quantity,source_type))";
  let result = await supabase.from("shipping_orders").select(`cancellation_status,${baseSelect}`).order("created_at", { ascending: false }).limit(500);
  if (result.error) result = await supabase.from("shipping_orders").select(baseSelect).order("created_at", { ascending: false }).limit(500);
  const findings: Array<{ order: OrderRow; issue: OrderHealthIssue }> = [];
  for (const order of (result.data ?? []) as unknown as OrderRow[]) {
    const qboVoided = String(order.qbo_invoices?.raw_payload?.PrivateNote ?? "").trim().toUpperCase() === "VOIDED";
    const issues = evaluateOrderHealth({ lines: order.shipping_order_lines ?? [], qboVoided, cancelled: String(order.cancellation_status ?? "").toUpperCase() === "CANCELLED" });
    for (const issue of issues) findings.push({ order, issue });
  }

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#d50917]">Operations</p><h1 className="mt-1 text-2xl font-semibold text-[#111827]">ERP Health / Exceptions</h1><p className="mt-2 text-sm text-[#64748b]">Read-only consistency findings across demand, queues, warehouse state, shipments, and mappings.</p></div>
          <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${findings.length ? "bg-[#fff7e6] text-[#92400e]" : "bg-[#e7f7ed] text-[#1b7a43]"}`}>{findings.length} issue{findings.length === 1 ? "" : "s"}</span>
        </div>
      </section>
      <div className="overflow-x-auto rounded-xl border border-[#e5e7eb] bg-white">
        <table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-[#f8fafc]"><tr className="border-b border-[#e5e7eb] text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]"><th className="px-3 py-3">Severity</th><th className="px-3 py-3">Invoice</th><th className="px-3 py-3">Customer</th><th className="px-3 py-3">Product</th><th className="px-3 py-3">Issue</th><th className="px-3 py-3">Expected</th><th className="px-3 py-3">Actual</th><th className="px-3 py-3">Investigate</th></tr></thead><tbody>{findings.map(({ order, issue }, index) => <tr key={`${order.id}-${issue.code}-${index}`} className="border-b border-[#f1f5f9] last:border-0"><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${severityClass(issue.severity)}`}>{issue.severity}</span></td><td className="px-3 py-3 font-semibold">{order.qbo_invoices?.invoice_number ?? order.order_number ?? "—"}</td><td className="px-3 py-3">{order.customers?.company_name ?? order.customers?.full_name ?? "Customer pending"}</td><td className="px-3 py-3">{issue.product ?? "Order"}</td><td className="px-3 py-3">{issue.issue}<p className="mt-1 text-xs text-[#64748b]">{issue.cause}</p></td><td className="px-3 py-3">{issue.expected}</td><td className="px-3 py-3">{issue.actual}</td><td className="px-3 py-3"><Link href={`/orders/${order.id}`} className="btn-secondary inline-flex text-xs">View order</Link></td></tr>)}</tbody></table>
        {findings.length === 0 ? <p className="p-6 text-sm text-[#64748b]">No discrepancies detected.</p> : null}
      </div>
    </div>
  );
}
