import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { isNonInventoryQuickbooksLine, qboSkuCandidates } from "@/lib/orders/quickbooks-refresh";
import { getQuickbooksFirstPaymentDates } from "@/lib/quickbooks/integration";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const CUTOFF = "2026-08-07T00:00:00.000Z";
const PAID_STATUSES = new Set(["Paid", "Partially Paid"]);

type InvoiceRow = {
  id: string;
  qbo_invoice_id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  payment_status: string;
  customer_id: string | null;
  raw_payload: { PrivateNote?: string | null; TxnStatus?: string | null; status?: string | null } | null;
};

type InvoiceLine = {
  id: string;
  qbo_invoice_id: string;
  qbo_line_id: string;
  qbo_sku: string | null;
  source_description: string | null;
  ordered_qty: number;
  product_id: string | null;
};

type ParentOrderRow = {
  id: string;
  source_invoice_id: string | null;
  duplicate_of_order_id?: string | null;
  order_number: string | null;
};

function formatDate(value: string | null) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function isVoided(invoice: InvoiceRow) {
  const payload = invoice.raw_payload ?? {};
  return invoice.payment_status === "Voided"
    || String(payload.PrivateNote ?? "").trim().toUpperCase() === "VOIDED"
    || String(payload.TxnStatus ?? payload.status ?? "").trim().toUpperCase() === "VOIDED";
}

export default async function ImportAssignOrdersPage() {
  await requireUser();
  const supabase = getSupabaseAdmin();

  let recoveryError: string | null = null;
  let firstPaymentByQboInvoiceId = new Map<string, string>();
  try {
    firstPaymentByQboInvoiceId = await getQuickbooksFirstPaymentDates();
  } catch (error) {
    recoveryError = error instanceof Error ? error.message : "Unable to query QuickBooks payment history.";
  }

  const [invoiceResult, lineResult, orderResult, productResult, aliasResult] = await Promise.all([
    supabase.from("qbo_invoices").select("id,qbo_invoice_id,invoice_number,invoice_date,payment_status,customer_id,raw_payload"),
    supabase.from("qbo_invoice_lines").select("id,qbo_invoice_id,qbo_line_id,qbo_sku,source_description,ordered_qty,product_id"),
    supabase.from("shipping_orders").select("id,source_invoice_id,duplicate_of_order_id,order_number"),
    supabase.from("products").select("id,sku"),
    supabase.from("product_aliases").select("product_id,alias"),
  ]);
  for (const result of [invoiceResult, lineResult, orderResult, productResult, aliasResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  const invoices = (invoiceResult.data ?? []) as unknown as InvoiceRow[];
  const invoiceLines = (lineResult.data ?? []) as unknown as InvoiceLine[];
  const customerIds = invoices.map((invoice) => invoice.customer_id).filter((id): id is string => Boolean(id));
  const { data: customerRows, error: customerError } = customerIds.length
    ? await supabase.from("customers").select("id,company_name,full_name").in("id", customerIds)
    : { data: [], error: null };
  if (customerError) throw new Error(customerError.message);

  const customerNameById = new Map((customerRows ?? []).map((customer) => [customer.id, customer.company_name ?? customer.full_name ?? "Customer pending"]));
  const productIdBySku = new Map<string, string>();
  for (const product of productResult.data ?? []) {
    if (product.sku) productIdBySku.set(product.sku.trim().toUpperCase(), product.id);
  }
  for (const alias of aliasResult.data ?? []) {
    if (alias.alias) productIdBySku.set(alias.alias.trim().toUpperCase(), alias.product_id);
  }
  const linesByInvoice = new Map<string, InvoiceLine[]>();
  for (const line of invoiceLines) {
    const lines = linesByInvoice.get(line.qbo_invoice_id) ?? [];
    lines.push(line);
    linesByInvoice.set(line.qbo_invoice_id, lines);
  }
  const canonicalOrderByInvoice = new Map<string, { id: string; order_number: string | null }>();
  const parentOrders = (orderResult.data ?? []) as unknown as ParentOrderRow[];
  for (const order of parentOrders) {
    if (!order.source_invoice_id || canonicalOrderByInvoice.has(order.source_invoice_id) || order.duplicate_of_order_id) continue;
    canonicalOrderByInvoice.set(order.source_invoice_id, order);
  }

  const eligibleRows = invoices
    .map((invoice) => {
      const firstPaymentDate = firstPaymentByQboInvoiceId.get(invoice.qbo_invoice_id) ?? null;
      const physicalItems = (linesByInvoice.get(invoice.id) ?? [])
        .filter((line) => Number(line.ordered_qty ?? 0) > 0 && !isNonInventoryQuickbooksLine(line))
        .map((line) => {
          const productId = line.product_id
            ?? qboSkuCandidates(line.qbo_sku).map((sku) => productIdBySku.get(sku)).find(Boolean)
            ?? null;
          return { sku: line.qbo_sku ?? line.source_description ?? "Unidentified item", quantity: Number(line.ordered_qty ?? 0), mapped: Boolean(productId) };
        });
      const mappedCount = physicalItems.filter((item) => item.mapped).length;
      const mappingStatus = physicalItems.length === 0 ? "No physical items" : mappedCount === physicalItems.length ? "All mapped" : mappedCount === 0 ? "Assignment required" : "Partially mapped";
      const existingOrder = canonicalOrderByInvoice.get(invoice.id) ?? null;
      const paymentEligible = firstPaymentDate !== null && Date.parse(firstPaymentDate) >= Date.parse(CUTOFF) && PAID_STATUSES.has(invoice.payment_status);
      return {
        invoice,
        firstPaymentDate,
        physicalItems,
        mappingStatus,
        existingOrder,
        eligible: paymentEligible && !isVoided(invoice),
      };
    })
    .filter((row) => row.eligible)
    .sort((left, right) => String(left.firstPaymentDate).localeCompare(String(right.firstPaymentDate)) || String(left.invoice.invoice_number).localeCompare(String(right.invoice.invoice_number)));
  const rows = eligibleRows.filter((row) => !row.existingOrder);
  const voidedExcluded = invoices.filter((invoice) => {
    const firstPaymentDate = firstPaymentByQboInvoiceId.get(invoice.qbo_invoice_id);
    return firstPaymentDate && Date.parse(firstPaymentDate) >= Date.parse(CUTOFF) && isVoided(invoice);
  }).length;
  const fullyMapped = rows.filter((row) => row.mappingStatus === "All mapped").length;
  const partiallyMapped = rows.filter((row) => row.mappingStatus === "Partially mapped").length;
  const unmapped = rows.filter((row) => row.mappingStatus === "Assignment required").length;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Orders & Shipping</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Import / Assign New Orders</h1>
            <p className="mt-2 max-w-3xl text-sm text-[#5a5a5a]">Read-only recovery review for QuickBooks invoices first paid on or after August 7, 2026. No order, demand, queue, inventory, or fulfillment data is changed here.</p>
          </div>
          <Link href="/orders" className="btn-secondary inline-flex">Back to Orders</Link>
        </div>
      </div>

      {recoveryError ? (
        <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-4 text-sm text-[#8f030d]">
          Unable to read QuickBooks payment history: {recoveryError}
        </div>
      ) : (
        <div className="rounded-lg border border-[#b7e4c7] bg-[#ecfdf3] p-4 text-sm text-[#166534]">
          Payment history checked. This table shows only the <strong>{rows.length}</strong> eligible invoice{rows.length === 1 ? "" : "s"} missing from the ERP.
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {[
          ["Eligible since Aug 7", eligibleRows.length, "bg-[#eff6ff] text-[#1d4ed8]"],
          ["Already represented", eligibleRows.length - rows.length, "bg-[#f1f5f9] text-[#475569]"],
          ["Missing from ERP", rows.length, "bg-[#fff7ed] text-[#c2410c]"],
          ["Fully mapped", fullyMapped, "bg-[#ecfdf5] text-[#15803d]"],
          ["Partially mapped", partiallyMapped, "bg-[#fff7ed] text-[#c2410c]"],
          ["Assignment required", unmapped, "bg-[#fff4f5] text-[#8f030d]"],
          ["Excluded / voided", voidedExcluded, "bg-[#f8fafc] text-[#475569]"],
        ].map(([label, value, color]) => (
          <div key={String(label)} className="rounded-lg border border-[#e5e7eb] bg-white p-3 shadow-sm">
            <span className={`inline-flex rounded px-2 py-1 text-xs font-semibold ${color}`}>{label}</span>
            <p className="mt-2 text-2xl font-bold text-[#111827]">{value}</p>
          </div>
        ))}
      </section>

      <div className="overflow-x-auto rounded-2xl border border-[#e5e7eb] bg-white shadow-sm">
        <table className="w-full min-w-[1200px] text-left text-sm">
          <thead className="bg-[#f8fafc] text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">
            <tr>
              <th className="px-4 py-3">Invoice / Customer</th>
              <th className="px-4 py-3">Payment</th>
              <th className="px-4 py-3">First Payment</th>
              <th className="px-4 py-3">Physical Products / Qty</th>
              <th className="px-4 py-3">Product Assignment</th>
              <th className="px-4 py-3">Existing ERP Order?</th>
              <th className="px-4 py-3">Would Import</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.invoice.id} className="border-t border-[#eef2f7] align-top">
                <td className="px-4 py-4">
                  <p className="font-semibold text-[#111827]">#{row.invoice.invoice_number ?? "—"}</p>
                  <p className="mt-1 text-xs text-[#64748b]">{customerNameById.get(row.invoice.customer_id ?? "") ?? "Customer pending"} · Invoice {formatDate(row.invoice.invoice_date)}</p>
                </td>
                <td className="px-4 py-4 font-medium text-[#334155]">{row.invoice.payment_status}</td>
                <td className="px-4 py-4 text-[#334155]">{formatDate(row.firstPaymentDate)}</td>
                <td className="px-4 py-4 text-[#334155]">
                  {row.physicalItems.length > 0 ? row.physicalItems.map((item) => <div key={`${item.sku}-${item.quantity}`}>{item.quantity} × {item.sku}</div>) : "No physical items"}
                </td>
                <td className="px-4 py-4"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${row.mappingStatus === "All mapped" ? "bg-[#ecfdf5] text-[#15803d]" : "bg-[#fff7ed] text-[#c2410c]"}`}>{row.mappingStatus}</span></td>
                <td className="px-4 py-4 font-semibold text-[#475569]">No</td>
                <td className="px-4 py-4 font-semibold text-[#b45309]">Yes, after approval</td>
              </tr>
            ))}
            {!recoveryError && rows.length === 0 ? <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-[#64748b]">No missing paid or partially paid QuickBooks invoices first paid on or after August 7, 2026 were found.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}