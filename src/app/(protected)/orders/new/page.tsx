import Link from "next/link";
import { createOrderFromQuickbooksInvoiceAction } from "../actions";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type SearchParams = { invoice?: string; error?: string };

export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireUser();
  const params = await searchParams;
  const invoiceSearch = String(params.invoice ?? "").trim();
  const supabase = getSupabaseAdmin();

  let invoices: Array<{
    id: string;
    invoice_number: string | null;
    customer_id: string | null;
    payment_status: string | null;
    invoice_date: string | null;
    total_amount: number | null;
    customerName: string;
    existingOrderId: string | null;
  }> = [];

  if (invoiceSearch) {
    const { data } = await supabase
      .from("qbo_invoices")
      .select("id, invoice_number, customer_id, payment_status, invoice_date, total_amount")
      .ilike("invoice_number", `%${invoiceSearch}%`)
      .order("invoice_date", { ascending: false })
      .limit(25);
    const rows = data ?? [];
    const customerIds = rows.map((row) => row.customer_id).filter(Boolean) as string[];
    const orderInvoiceIds = rows.map((row) => row.id);
    const [{ data: customers }, { data: existingOrders }] = await Promise.all([
      customerIds.length ? supabase.from("customers").select("id, full_name, company_name").in("id", customerIds) : Promise.resolve({ data: [] }),
      orderInvoiceIds.length ? supabase.from("shipping_orders").select("id, source_invoice_id").in("source_invoice_id", orderInvoiceIds) : Promise.resolve({ data: [] }),
    ]);
    const customerNames = new Map((customers ?? []).map((customer) => [customer.id, customer.company_name ?? customer.full_name ?? "Customer pending"]));
    const existingByInvoice = new Map((existingOrders ?? []).map((order) => [order.source_invoice_id, order.id]));
    invoices = rows.map((row) => ({
      ...row,
      customerName: customerNames.get(row.customer_id ?? "") ?? "Customer pending",
      existingOrderId: existingByInvoice.get(row.id) ?? null,
    }));
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Orders & Shipping</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Enter New Order</h1>
            <p className="mt-2 max-w-2xl text-sm text-[#5a5a5a]">Find a QuickBooks invoice and add it to the product and customer queues. Duplicate invoice numbers are shown separately so you can choose the correct customer.</p>
          </div>
          <Link href="/orders" className="btn-secondary inline-flex">Back to Orders</Link>
        </div>
      </div>

      {params.error ? <p className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{params.error}</p> : null}

      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <form method="GET" className="flex flex-wrap items-end gap-3">
          <div className="min-w-[280px] flex-1">
            <label htmlFor="invoice" className="label">QuickBooks invoice number</label>
            <input id="invoice" name="invoice" defaultValue={invoiceSearch} className="input mt-2" placeholder="Type invoice number" autoFocus />
          </div>
          <button type="submit" className="btn-primary">Find Invoice</button>
        </form>
      </section>

      {invoiceSearch && invoices.length === 0 ? <p className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#64748b]">No QuickBooks invoices matched that number.</p> : null}

      {invoices.length > 0 ? (
        <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-[#111827]">Matching QuickBooks Invoices</h2>
          <div className="mt-4 space-y-3">
            {invoices.map((invoice) => (
              <div key={invoice.id} className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-4">
                <div>
                  <p className="font-semibold text-[#111827]">Invoice #{invoice.invoice_number ?? "—"}</p>
                  <p className="mt-1 text-sm text-[#334155]">{invoice.customerName}</p>
                  <p className="mt-1 text-xs text-[#64748b]">{invoice.invoice_date ?? "Date unavailable"} · {invoice.payment_status ?? "Payment status unavailable"} · {invoice.total_amount == null ? "Total unavailable" : `$${invoice.total_amount.toFixed(2)}`}</p>
                </div>
                {invoice.existingOrderId ? (
                  <Link href={`/orders/${invoice.existingOrderId}`} className="btn-secondary inline-flex">Open Order</Link>
                ) : (
                  <form action={createOrderFromQuickbooksInvoiceAction}>
                    <input type="hidden" name="qbo_invoice_id" value={invoice.id} />
                    <button type="submit" className="btn-primary">Add to New Orders</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}