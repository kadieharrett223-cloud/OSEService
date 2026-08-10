import { createClient } from "@/lib/supabase/server";
import { approveReviewLineAction, holdReviewLineAction } from "./actions";

type ReviewLine = {
  id: string;
  qbo_sku: string | null;
  source_description: string | null;
  ordered_qty: number | null;
  approval_status: string | null;
  warehouse_status: string | null;
  fulfillment_status: string | null;
  qbo_invoice_id: string | null;
  qbo_invoices?: {
    id: string;
    invoice_number: string | null;
    payment_status: string | null;
  } | null;
};

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusBadgeClass(value: string | null | undefined) {
  if (value === "APPROVED" || value === "READY") return "bg-[#e7f7ed] text-[#1b7a43]";
  if (value === "PENDING_REVIEW" || value === "PENDING") return "bg-[#fef3c7] text-[#92400e]";
  if (value === "HOLD") return "bg-[#fee2e2] text-[#b91c1c]";
  return "bg-[#eef2f7] text-[#334155]";
}

export default async function ShippingReviewPage() {
  const supabase = await createClient();
  const { data: reviewRows, error } = await supabase
    .from("qbo_invoice_lines")
    .select(`
      id,
      qbo_sku,
      source_description,
      ordered_qty,
      approval_status,
      warehouse_status,
      fulfillment_status,
      qbo_invoice_id,
      qbo_invoices (id, invoice_number, payment_status)
    `)
    .order("created_at", { ascending: false })
    .limit(40);

  const reviewLines = (reviewRows ?? []) as ReviewLine[];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Shipping Review</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">
          Paid QuickBooks invoices enter this queue first. Shipping can review, approve, hold, or remove lines before they become sold or open demand.
        </p>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-[#111827]">Pending review lines</h2>
          <div className="rounded-full bg-[#eef2f7] px-3 py-1 text-sm font-medium text-[#334155]">
            {reviewLines.length} visible
          </div>
        </div>

        {error ? (
          <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Unable to load review lines right now.</div>
        ) : null}

        {!error && reviewLines.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No invoice lines have been imported yet.
          </div>
        ) : null}

        {!error && reviewLines.length > 0 ? (
          <div className="space-y-3">
            {reviewLines.map((line) => {
              const productName = line.source_description ?? line.qbo_sku ?? "Unmapped product";
              const invoiceNumber = line.qbo_invoices?.invoice_number ?? "—";
              const paymentStatus = line.qbo_invoices?.payment_status ?? "Pending";
              return (
                <div key={line.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-[#111827]">{productName}</p>
                      <p className="mt-1 text-sm text-[#5a5a5a]">
                        Invoice #{invoiceNumber} • {paymentStatus}
                      </p>
                    </div>
                    <div className="text-right text-sm text-[#374151]">
                      <p>Qty {line.ordered_qty ?? 0}</p>
                      <p className="mt-1 text-xs text-[#6b7280]">Warehouse: {formatStatus(line.warehouse_status)}</p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(line.approval_status)}`}>
                      Approval: {formatStatus(line.approval_status)}
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(line.fulfillment_status)}`}>
                      Fulfillment: {formatStatus(line.fulfillment_status)}
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(line.warehouse_status)}`}>
                      Queue: {formatStatus(line.warehouse_status)}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <form action={approveReviewLineAction}>
                      <input type="hidden" name="lineId" value={line.id} />
                      <button type="submit" className="btn-primary">Approve</button>
                    </form>
                    <form action={holdReviewLineAction}>
                      <input type="hidden" name="lineId" value={line.id} />
                      <button type="submit" className="btn-secondary">Hold</button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
