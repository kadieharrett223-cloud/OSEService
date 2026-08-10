import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type ContainerDetailRow = {
  id: string;
  container_number: string;
  supplier: string | null;
  order_date: string | null;
  entered_date: string | null;
  deposit_amount: number | null;
  deposit_date: string | null;
  final_payment_amount: number | null;
  final_payment_date: string | null;
  remaining_balance: number | null;
  payment_status: string | null;
  production_status: string | null;
  lifecycle_status: string | null;
  tracking_number: string | null;
  eta_confirmed_date: string | null;
  eta_estimated_date: string | null;
  port_date: string | null;
  notes: string | null;
  container_lines?: Array<{
    id: string;
    ordered_qty: number | null;
    received_qty: number | null;
    products: { sku: string | null; canonical_name: string | null } | null;
  }>;
};

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatCurrency(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(numeric)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(numeric);
}

export default async function ContainerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: containerData, error } = await supabase
    .from("containers")
    .select(`
      id,
      container_number,
      supplier,
      order_date,
      entered_date,
      deposit_amount,
      deposit_date,
      final_payment_amount,
      final_payment_date,
      remaining_balance,
      payment_status,
      production_status,
      lifecycle_status,
      tracking_number,
      eta_confirmed_date,
      eta_estimated_date,
      port_date,
      notes,
      container_lines (
        id,
        ordered_qty,
        received_qty,
        product_id,
        products (sku, canonical_name)
      )
    `)
    .eq("id", id)
    .maybeSingle();

  if (error || !containerData) {
    notFound();
  }

  const container = containerData as ContainerDetailRow;
  const lines = (container.container_lines ?? []) as Array<{
    id: string;
    ordered_qty: number | null;
    received_qty: number | null;
    products: { sku: string | null; canonical_name: string | null } | null;
  }>;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold text-[#111827]">{container.container_number}</h1>
            <p className="mt-2 text-sm text-[#5a5a5a]">Review the product lines, logistics, and payment details for this container.</p>
          </div>
          <Link href="/containers" className="btn-secondary">Back to Containers</Link>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-[#111827]">Product Lines</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-[#e5e7eb] text-sm">
              <thead className="bg-[#f9fafb] text-left text-[#6b7280]">
                <tr>
                  <th className="px-3 py-3 font-semibold">SKU</th>
                  <th className="px-3 py-3 font-semibold">Product</th>
                  <th className="px-3 py-3 font-semibold">Qty Ordered</th>
                  <th className="px-3 py-3 font-semibold">Qty Received</th>
                  <th className="px-3 py-3 font-semibold">Allocated</th>
                  <th className="px-3 py-3 font-semibold">Available to Sell</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e5e7eb] bg-white">
                {lines.length > 0 ? lines.map((line) => {
                  const ordered = Number(line.ordered_qty ?? 0);
                  const received = Number(line.received_qty ?? 0);
                  const allocated = 0;
                  const available = Math.max(received - allocated, 0);

                  return (
                    <tr key={line.id}>
                      <td className="px-3 py-3 font-medium text-[#111827]">{line.products?.sku ?? "—"}</td>
                      <td className="px-3 py-3 text-[#374151]">{line.products?.canonical_name ?? "—"}</td>
                      <td className="px-3 py-3">{ordered}</td>
                      <td className="px-3 py-3">{received}</td>
                      <td className="px-3 py-3">{allocated}</td>
                      <td className="px-3 py-3">{available}</td>
                    </tr>
                  );
                }) : (
                  <tr>
                    <td className="px-3 py-3 text-[#6b7280]" colSpan={6}>No products have been added to this container yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-[#111827]">Basic Information</h2>
            <dl className="mt-4 space-y-3 text-sm text-[#374151]">
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Supplier</dt>
                <dd>{container.supplier ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Status</dt>
                <dd>{container.lifecycle_status}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Order Date</dt>
                <dd>{formatDate(container.order_date)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Entered Date</dt>
                <dd>{formatDate(container.entered_date)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Tracking</dt>
                <dd>{container.tracking_number ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">ETA</dt>
                <dd>{container.eta_confirmed_date ? formatDate(container.eta_confirmed_date) : container.eta_estimated_date ? formatDate(container.eta_estimated_date) : "Pending"}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-[#111827]">Payment & Logistics</h2>
            <dl className="mt-4 space-y-3 text-sm text-[#374151]">
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Payment Status</dt>
                <dd>{container.payment_status ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Deposit</dt>
                <dd>{formatCurrency(container.deposit_amount)}{container.deposit_date ? ` • ${formatDate(container.deposit_date)}` : ""}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Final Payment</dt>
                <dd>{formatCurrency(container.final_payment_amount)}{container.final_payment_date ? ` • ${formatDate(container.final_payment_date)}` : ""}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Remaining Balance</dt>
                <dd>{formatCurrency(container.remaining_balance)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Port Date</dt>
                <dd>{formatDate(container.port_date)}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-[#111827]">Notes</h2>
            <p className="mt-3 whitespace-pre-wrap text-sm text-[#374151]">{container.notes || "No notes have been added for this container yet."}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
