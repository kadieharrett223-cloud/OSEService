import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { canViewMySales } from "@/lib/roles";
import { redirect } from "next/navigation";

type InvoiceLineSummary = {
  id: string;
  qbo_sku: string | null;
  source_description: string | null;
  ordered_qty: number | null;
  approval_status: string | null;
  warehouse_status: string | null;
  allocation_status: string | null;
  fulfillment_status: string | null;
  product_id: string | null;
  products: { sku: string | null; canonical_name: string | null } | null;
};

type InvoiceSummary = {
  id: string;
  invoice_number: string | null;
  payment_status: string | null;
  invoice_date: string | null;
  raw_payload: unknown;
  customer_id: string | null;
  customers: { full_name: string | null; company_name: string | null } | null;
  qbo_invoice_lines?: InvoiceLineSummary[];
};

type FilterValue = "all" | "awaiting-review" | "approved-waiting" | "ready" | "partial" | "shipped";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function normalizeFilter(value: string | undefined): FilterValue {
  if (value === "awaiting-review" || value === "approved-waiting" || value === "ready" || value === "partial" || value === "shipped") {
    return value;
  }
  return "all";
}

function getInvoiceStage(invoice: InvoiceSummary): FilterValue {
  const lines = invoice.qbo_invoice_lines ?? [];
  if (lines.length === 0) return "all";

  const anyShipped = lines.some((line) => line.fulfillment_status === "FULFILLED");
  const anyPartial = lines.some((line) => line.fulfillment_status === "PARTIALLY_FULFILLED");
  const anyReady = lines.some((line) => line.warehouse_status === "READY_TO_SHIP" || line.warehouse_status === "IN_WAREHOUSE");
  const anyApproved = lines.some((line) => line.approval_status === "APPROVED");

  if (anyShipped) return "shipped";
  if (anyPartial) return "partial";
  if (anyReady) return "ready";
  if (anyApproved) return "approved-waiting";
  return "awaiting-review";
}

function getLineStatus(line: InvoiceLineSummary) {
  if (line.fulfillment_status === "FULFILLED") {
    return { label: "Shipped", inventory: "Shipped", container: "Completed" };
  }

  if (line.fulfillment_status === "PARTIALLY_FULFILLED") {
    return { label: "Partial", inventory: "Partially fulfilled", container: "In progress" };
  }

  if (line.warehouse_status === "IN_WAREHOUSE" || line.warehouse_status === "READY_TO_SHIP") {
    return { label: line.warehouse_status === "READY_TO_SHIP" ? "Ready" : "In Warehouse", inventory: "In stock", container: "Warehouse ready" };
  }

  if (line.approval_status === "APPROVED") {
    return { label: "Approved / Waiting", inventory: "Waiting on inventory", container: "Incoming container pending" };
  }

  return { label: "Awaiting Review", inventory: "Waiting on inventory", container: "Incoming container pending" };
}

export default async function MySalesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const user = await requireUser();
  if (!canViewMySales(user.fullName)) {
    redirect("/dashboard");
  }

  const params = await searchParams;
  const query = String(params.q ?? "").trim().toLowerCase();
  const filter = normalizeFilter(params.filter);

  const supabase = await createClient();

  const { data: invoiceRows, error } = await supabase
    .from("qbo_invoices")
    .select(`
      id,
      invoice_number,
      payment_status,
      invoice_date,
      raw_payload,
      customer_id,
      customers (full_name, company_name),
      qbo_invoice_lines (
        id,
        qbo_sku,
        source_description,
        ordered_qty,
        approval_status,
        warehouse_status,
        allocation_status,
        fulfillment_status,
        product_id,
        products (sku, canonical_name)
      )
    `)
    .order("invoice_date", { ascending: false });

  const invoices = ((invoiceRows ?? []) as InvoiceSummary[]).filter((invoice) => {
    const customerText = `${invoice.customers?.full_name ?? ""} ${invoice.customers?.company_name ?? ""} ${invoice.invoice_number ?? ""}`.toLowerCase();
    if (query && !customerText.includes(query)) {
      return false;
    }

    if (filter === "all") {
      return true;
    }

    return getInvoiceStage(invoice) === filter;
  });

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold text-[#111827]">My Sales</h1>
            <p className="mt-2 text-sm text-[#5a5a5a]">
              Read-only visibility into paid orders after they enter the shipping workflow. Shipping remains responsible for approvals and fulfillment updates.
            </p>
          </div>
          <div className="rounded-full bg-[#eef2f7] px-3 py-1 text-sm font-medium text-[#334155]">
            {user.fullName ?? "Sales User"}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-[#111827]">Paid Orders in Shipping Workflow</h2>
          <p className="text-sm text-[#6b7280]">This is a visibility dashboard only. Shipping manages the operational status.</p>
        </div>

        <form method="get" action="/my-sales" className="mb-5 flex flex-wrap gap-3 rounded-xl border border-[#e5e7eb] bg-[#f9fafb] p-3">
          <input
            type="text"
            name="q"
            defaultValue={query}
            placeholder="Search customer or invoice"
            className="input min-w-[240px]"
          />
          <select name="filter" defaultValue={filter} className="select min-w-[180px]">
            <option value="all">All</option>
            <option value="awaiting-review">Awaiting Review</option>
            <option value="approved-waiting">Approved / Waiting</option>
            <option value="ready">Ready</option>
            <option value="partial">Partial</option>
            <option value="shipped">Shipped</option>
          </select>
          <button type="submit" className="btn-secondary">Apply</button>
          <a href="/my-sales" className="btn-secondary inline-flex">Reset</a>
        </form>

        {error ? (
          <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Unable to load sales visibility data right now.</div>
        ) : null}

        {!error && invoices.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No paid invoices match the current search or filter.
          </div>
        ) : null}

        {!error && invoices.length > 0 ? (
          <div className="space-y-4">
            {invoices.map((invoice) => {
              const stage = getInvoiceStage(invoice);
              return (
                <details key={invoice.id} className="group rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-lg font-semibold text-[#111827]">Invoice #{invoice.invoice_number ?? "—"}</h3>
                        <p className="text-sm text-[#5a5a5a]">
                          {invoice.customers?.full_name ?? "Unknown customer"}
                          {invoice.customers?.company_name ? ` • ${invoice.customers.company_name}` : ""}
                        </p>
                      </div>
                      <div className="text-sm text-[#6b7280]">
                        <div>Paid date: {formatDate(invoice.invoice_date)}</div>
                        <div className="mt-1 font-medium text-[#334155]">Status: {stage === "awaiting-review" ? "Awaiting Review" : stage === "approved-waiting" ? "Approved / Waiting" : stage === "ready" ? "Ready" : stage === "partial" ? "Partial" : stage === "shipped" ? "Shipped" : "All"}</div>
                      </div>
                    </div>
                  </summary>

                  <div className="mt-4 space-y-2">
                    {(invoice.qbo_invoice_lines ?? []).map((line) => {
                      const productName = line.products?.canonical_name ?? line.products?.sku ?? line.source_description ?? "Unmapped product";
                      const lineStatus = getLineStatus(line);
                      return (
                        <div key={line.id} className="rounded-lg border border-[#e5e7eb] bg-white p-3 text-sm">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="font-medium text-[#111827]">{productName}</p>
                              <p className="text-[#6b7280]">Qty {line.ordered_qty ?? 0}</p>
                            </div>
                            <div className="flex-1 text-right text-[#374151]">
                              <p className="font-medium">{lineStatus.label}</p>
                              <p className="text-xs text-[#6b7280]">Inventory: {lineStatus.inventory}</p>
                              <p className="text-xs text-[#6b7280]">Queue: {line.approval_status === "APPROVED" ? "Approved" : line.approval_status === "PENDING_REVIEW" ? "Awaiting Review" : "Pending"}</p>
                              <p className="text-xs text-[#6b7280]">Container: {lineStatus.container}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
