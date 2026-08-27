import Link from "next/link";
import { unstable_cache } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { findActiveDuplicateParentConflicts } from "@/lib/orders/duplicate-parent-health";
import { ERP_HEALTH_CACHE_TAG } from "@/lib/orders/erp-health-cache";
import { evaluateOrderHealth, type HealthLine, type OrderHealthIssue } from "@/lib/orders/order-health";
import { selectForwardIntakeReviewCandidates, previewQboForwardIntake } from "@/lib/orders/qbo-forward-intake-service";
import { getQuickbooksFirstPaymentDates } from "@/lib/quickbooks/integration";
import { ExceptionAction } from "./exception-action";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type OrderRow = {
  id: string;
  order_number: string | null;
  source_type?: string | null;
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

const getCachedErpHealthFindings = unstable_cache(async () => {
  const supabase = getSupabaseAdmin();
  const baseSelect = "id,order_number,source_type,customers(company_name,full_name),qbo_invoices(invoice_number,raw_payload),shipping_order_lines(id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,warehouse_status,queue_position_start,queue_position_count,products(sku,canonical_name),inventory_allocations(quantity,source_type))";
  let result = await supabase.from("shipping_orders").select(`cancellation_status,${baseSelect}`).order("created_at", { ascending: false }).limit(500);
  if (result.error) result = await supabase.from("shipping_orders").select(baseSelect).order("created_at", { ascending: false }).limit(500);
  const findings: Array<{ order: OrderRow; issue: OrderHealthIssue }> = [];
  for (const order of (result.data ?? []) as unknown as OrderRow[]) {
    const qboVoided = String(order.qbo_invoices?.raw_payload?.PrivateNote ?? "").trim().toUpperCase() === "VOIDED";
    const issues = evaluateOrderHealth({ lines: order.shipping_order_lines ?? [], qboRawPayload: order.qbo_invoices?.raw_payload, qboVoided, cancelled: String(order.cancellation_status ?? "").toUpperCase() === "CANCELLED" });
    for (const issue of issues) findings.push({ order, issue });
  }
  const forwardIntake = await previewQboForwardIntake(await getQuickbooksFirstPaymentDates());
  for (const invoice of selectForwardIntakeReviewCandidates(forwardIntake)) {
    const issueCode = invoice.decision === "MAPPING_REVIEW" ? "QBO_FORWARD_MAPPING_REVIEW" : "QBO_FORWARD_IDENTITY_REVIEW";
    findings.push({
      order: {
        id: invoice.qboInvoiceId,
        order_number: invoice.invoiceNumber,
        customers: { company_name: invoice.customerName, full_name: null },
        qbo_invoices: { invoice_number: invoice.invoiceNumber },
        shipping_order_lines: [],
      },
      issue: {
        severity: "WARNING",
        code: issueCode,
        product: null,
        issue: invoice.decision === "MAPPING_REVIEW" ? "Recent QuickBooks order needs product mapping" : "Recent QuickBooks order has an identity conflict",
        expected: invoice.decision === "MAPPING_REVIEW" ? "Map every physical QuickBooks line" : "Resolve the conflicting QBO invoice or line identity",
        actual: `${invoice.lines.filter((line) => line.decision === invoice.decision).length} line${invoice.lines.filter((line) => line.decision === invoice.decision).length === 1 ? "" : "s"} require review`,
        cause: "This is a recent paid or partially paid QuickBooks invoice selected by the shared forward-intake preflight. No ERP demand has been created.",
      },
    });
  }
  const ordersByNumber = new Map<string, OrderRow[]>();
  for (const order of (result.data ?? []) as unknown as OrderRow[]) {
    const key = String(order.qbo_invoices?.invoice_number ?? order.order_number ?? "").trim().toUpperCase();
    if (!key) continue;
    ordersByNumber.set(key, [...(ordersByNumber.get(key) ?? []), order]);
  }
  for (const [invoiceNumber, orders] of ordersByNumber) {
    const customerNames = new Set(orders.map((order) => String(order.customers?.company_name ?? order.customers?.full_name ?? "").trim().toUpperCase()).filter(Boolean));
    if (customerNames.size <= 1) continue;
    for (const order of orders) findings.push({ order, issue: { severity: "WARNING", code: "AMBIGUOUS_ORDER_NUMBER_BRIDGE", product: null, issue: "Same invoice/order number appears under multiple customers", expected: "Do not bridge by order number alone", actual: `${invoiceNumber}: ${[...customerNames].join(" / ")}`, cause: "Order-number-only identity is ambiguous and must require compatible customer/source evidence before combining demand." } });
  }
  const duplicateParentRows: unknown[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("shipping_orders")
      .select("id,order_number,source_type,source_system,source_invoice_id,duplicate_of_order_id,legacy_customer_name,customers(company_name,full_name),shipping_order_lines(product_id,ordered_qty,approved_qty,fulfilled_qty,products(sku,canonical_name))")
      .is("duplicate_of_order_id", null)
      .not("source_invoice_id", "is", null)
      .range(from, from + 999);
    if (error) throw new Error(`Duplicate-parent ERP Health query failed: ${error.message}`);
    duplicateParentRows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const duplicateParentConflicts = findActiveDuplicateParentConflicts((duplicateParentRows as Array<{
    id: string;
    order_number: string | null;
    source_type: string | null;
    source_system: string | null;
    source_invoice_id: string | null;
    duplicate_of_order_id: string | null;
    legacy_customer_name: string | null;
    customers?: { company_name: string | null; full_name: string | null } | null;
    shipping_order_lines?: HealthLine[];
  }>).map((order) => ({
    ...order,
    customerName: order.customers?.company_name ?? order.customers?.full_name ?? order.legacy_customer_name,
    lines: order.shipping_order_lines ?? [],
  })));
  for (const conflict of duplicateParentConflicts) {
    findings.push({
      order: { id: conflict.canonicalOrderId, order_number: conflict.invoice, customers: { company_name: conflict.customer, full_name: null }, shipping_order_lines: [] },
      issue: {
        severity: "WARNING",
        code: "PARENT_EVIDENCE_CONFLICT",
        relatedOrderId: conflict.staleOrderId,
        product: "Sibling parents",
        issue: "Active QBO and OLD_ERP parents conflict",
        expected: `One active operational parent; QBO ${conflict.canonicalOrderId} ${conflict.canonical.ordered} ordered / ${conflict.canonical.fulfilled} fulfilled / ${conflict.canonical.remaining} remaining (${conflict.canonical.products.join(", ") || "no products"})`,
        actual: `OLD_ERP ${conflict.staleOrderId} ${conflict.stale.ordered} ordered / ${conflict.stale.fulfilled} fulfilled / ${conflict.stale.remaining} remaining (${conflict.stale.products.join(", ") || "no products"})`,
        cause: "Source identity is shared, but product, quantity, or fulfillment evidence differs. Review both preserved parents individually; ERP Health cannot retire either parent.",
      },
    });
  }
  return findings;
}, ["erp-health-findings"], { revalidate: 30, tags: [ERP_HEALTH_CACHE_TAG] });

export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<{ severity?: string; type?: string; warehouse?: string; customer?: string; product?: string; view?: string; recheck?: string }> }) {
  await requireUser();
  const findings = await getCachedErpHealthFindings();
  const params = await searchParams;
  const severity = String(params.severity ?? "").toUpperCase();
  const issueType = String(params.type ?? "");
  const warehouse = String(params.warehouse ?? "").toUpperCase();
  const customer = String(params.customer ?? "").trim().toLowerCase();
  const product = String(params.product ?? "").trim().toLowerCase();
  const view = String(params.view ?? "");
  const viewCodes: Record<string, string[]> = {
    demand: ["QUEUE_COUNT_MISMATCH", "QUEUE_POSITION_MISSING", "RESERVATION_EXCEEDS_DEMAND"],
    qbo: ["VOIDED_ACTIVE", "FULFILLED_WITH_OPEN_DEMAND"],
    review: ["QBO_FORWARD_MAPPING_REVIEW", "QBO_FORWARD_IDENTITY_REVIEW"],
    shipment: ["SHIPMENT_EXCEEDS_DEMAND", "FULFILLMENT_TOTAL_MISMATCH"],
    voided: ["VOIDED_ACTIVE", "CANCELLED_OPEN_DEMAND"],
    mapping: ["UNMAPPED_PHYSICAL_LINE"],
    duplicates: ["PARENT_EVIDENCE_CONFLICT"],
  };
  const severityRank: Record<string, number> = { ERROR: 0, WARNING: 1, INFO: 2 };
  const filteredFindings = findings.filter(({ order, issue }) => {
    const name = `${order.customers?.company_name ?? ""} ${order.customers?.full_name ?? ""}`.toLowerCase();
    const matchesView = !view || (viewCodes[view] ?? []).includes(issue.code);
    return (!severity || issue.severity === severity) && (!issueType || issue.code === issueType) && (!warehouse || String(issue.warehouseStatus ?? "").toUpperCase() === warehouse) && (!customer || name.includes(customer)) && (!product || String(issue.product ?? "").toLowerCase().includes(product)) && matchesView;
  }).sort((left, right) => severityRank[left.issue.severity] - severityRank[right.issue.severity]);
  const counts = {
    ERROR: findings.filter(({ issue }) => issue.severity === "ERROR").length,
    WARNING: findings.filter(({ issue }) => issue.severity === "WARNING").length,
    INFO: findings.filter(({ issue }) => issue.severity === "INFO").length,
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#d50917]">Operations</p><h1 className="mt-1 text-2xl font-semibold text-[#111827]">ERP Health / Exceptions</h1><p className="mt-2 text-sm text-[#64748b]">Read-only consistency findings across demand, queues, warehouse state, shipments, and mappings.</p></div>
          <div className="flex items-center gap-2"><span className="text-xs font-semibold text-[#b91c1c]">Errors {counts.ERROR}</span><span className="text-xs font-semibold text-[#92400e]">Warnings {counts.WARNING}</span><span className="text-xs font-semibold text-[#475569]">Info {counts.INFO}</span><Link href="/exceptions?recheck=1" className="btn-secondary text-xs">Recheck</Link></div>
        </div>
      </section>
      <form method="GET" className="flex flex-wrap items-end gap-2 rounded-xl border border-[#e5e7eb] bg-white p-3">
        <label className="text-xs font-semibold text-[#64748b]">Severity<select name="severity" defaultValue={severity} className="input mt-1"><option value="">All</option><option value="ERROR">Error</option><option value="WARNING">Warning</option><option value="INFO">Info</option></select></label>
        <label className="text-xs font-semibold text-[#64748b]">Issue type<select name="type" defaultValue={issueType} className="input mt-1"><option value="">All</option>{[...new Set(findings.map(({ issue }) => issue.code))].sort().map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
        <label className="text-xs font-semibold text-[#64748b]">Warehouse<select name="warehouse" defaultValue={warehouse} className="input mt-1"><option value="">All</option>{[...new Set(findings.map(({ issue }) => issue.warehouseStatus).filter(Boolean))].sort().map((value) => <option key={value} value={value!}>{value}</option>)}</select></label>
        <input name="customer" defaultValue={params.customer ?? ""} placeholder="Customer" className="input" />
        <input name="product" defaultValue={params.product ?? ""} placeholder="Product / SKU" className="input" />
        <button type="submit" className="btn-secondary">Filter</button><Link href="/exceptions" className="btn-ghost">Clear</Link>
      </form>
      <div className="flex flex-wrap gap-2 text-xs font-semibold"><span className="text-[#64748b]">Quick views:</span>{Object.entries({ demand: "Demand / queue", qbo: "QBO / ERP", review: "Manual review", shipment: "Shipment / inventory", voided: "Voided / cancelled", mapping: "Mapping", duplicates: "Duplicate parents" }).map(([key, label]) => <Link key={key} href={`/exceptions?view=${key}`} className={`rounded-full px-2.5 py-1 ${view === key ? "bg-[#dbeafe] text-[#1d4ed8]" : "bg-[#f1f5f9] text-[#475569]"}`}>{label}</Link>)}</div>
      <div className="overflow-x-auto rounded-xl border border-[#e5e7eb] bg-white">
        <table className="w-full min-w-[1000px] text-left text-sm"><thead className="bg-[#f8fafc]"><tr className="border-b border-[#e5e7eb] text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]"><th className="px-3 py-3">Severity</th><th className="px-3 py-3">Invoice</th><th className="px-3 py-3">Customer</th><th className="px-3 py-3">Product</th><th className="px-3 py-3">Issue</th><th className="px-3 py-3">Expected</th><th className="px-3 py-3">Actual</th><th className="px-3 py-3">Action</th></tr></thead><tbody>{filteredFindings.map(({ order, issue }, index) => { const lines = order.shipping_order_lines ?? []; const line = issue.lineId ? lines.find((candidate) => candidate.id === issue.lineId) : null; const openDemand = (line ? [line] : lines).reduce((sum, candidate) => sum + Math.max(0, Number(candidate.approved_qty ?? candidate.ordered_qty ?? 0) - Number(candidate.fulfilled_qty ?? 0)), 0); const queueUnits = (line ? [line] : lines).reduce((sum, candidate) => sum + Number(candidate.queue_position_count ?? 0), 0); const reservationUnits = (line ? [line] : lines).reduce((sum, candidate) => sum + (candidate.inventory_allocations ?? []).reduce((inner, allocation) => inner + Number(allocation.quantity ?? 0), 0), 0); const shippedQty = (line ? [line] : lines).reduce((sum, candidate) => sum + Number(candidate.fulfilled_qty ?? 0), 0); return <tr key={`${order.id}-${issue.code}-${index}`} className="border-b border-[#f1f5f9] last:border-0"><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${severityClass(issue.severity)}`}>{issue.severity}</span></td><td className="px-3 py-3 font-semibold">{order.qbo_invoices?.invoice_number ?? order.order_number ?? "—"}</td><td className="px-3 py-3">{order.customers?.company_name ?? order.customers?.full_name ?? "Customer pending"}</td><td className="px-3 py-3">{issue.product ?? "Order"}</td><td className="px-3 py-3">{issue.issue}<p className="mt-1 text-xs text-[#64748b]">{issue.cause}</p></td><td className="px-3 py-3">{issue.expected}</td><td className="px-3 py-3">{issue.actual}</td><td className="px-3 py-3"><ExceptionAction orderId={order.id} invoice={order.qbo_invoices?.invoice_number ?? order.order_number ?? "—"} issueCode={issue.code} productId={line?.product_id} productSku={line?.products?.sku ?? line?.legacy_item_code} openDemand={openDemand} queueUnits={queueUnits} reservationUnits={reservationUnits} containerUnits={0} shippedQty={shippedQty} lineId={issue.lineId} /></td></tr>; })}</tbody></table>
        {filteredFindings.length === 0 ? <p className="p-6 text-sm text-[#64748b]">No discrepancies match these filters.</p> : null}
      </div>
    </div>
  );
}
