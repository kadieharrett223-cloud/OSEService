import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { acceptContainerToWarehouseAction } from "../actions";

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

type ContainerAllocationPreview = {
  id: string;
  quantity: number | null;
  product_id: string | null;
  shipping_order_line_id: string | null;
  shipping_order_lines?: {
    id: string;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    warehouse_status: string | null;
    queue_position_start: number | null;
    products?: { sku: string | null; canonical_name: string | null } | null;
    shipping_orders?: {
      id: string;
      qbo_invoices?: {
        invoice_number: string | null;
        customers?: {
          company_name: string | null;
          first_name: string | null;
          last_name: string | null;
        } | null;
      } | null;
    } | null;
  } | null;
};

type CustomerImpactRow = {
  lineId: string;
  orderId: string;
  invoice: string;
  customer: string;
  sku: string;
  allocationQty: number;
  remainingQty: number;
  queuePosition: number | null;
  currentWarehouse: string;
  willMarkInWarehouse: boolean;
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

function formatStatus(value: string | null | undefined) {
  if (!value) return "Pending";
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

export default async function ContainerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();

  const [{ data: containerData, error }, { data: allocationData }] = await Promise.all([
    supabase
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
          on_order_qty,
          received_qty,
          product_id,
          products (sku, canonical_name)
        )
      `)
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("inventory_allocations")
      .select(`
        id,
        quantity,
        product_id,
        shipping_order_line_id,
        shipping_order_lines (
          id,
          approved_qty,
          fulfilled_qty,
          warehouse_status,
          queue_position_start,
          products (sku, canonical_name),
          shipping_orders (
            id,
            qbo_invoices (
              invoice_number,
              customers (company_name, first_name, last_name)
            )
          )
        )
      `)
      .eq("container_id", id)
      .eq("source_type", "CONTAINER")
      .eq("allocation_status", "ALLOCATED"),
  ]);

  if (error || !containerData) {
    notFound();
  }

  const container = containerData as ContainerDetailRow;
  const lines = (container.container_lines ?? []) as Array<{
    id: string;
    ordered_qty: number | null;
    on_order_qty: number | null;
    received_qty: number | null;
    product_id?: string | null;
    products: { sku: string | null; canonical_name: string | null } | null;
  }>;

  const allocationRows = (allocationData ?? []) as ContainerAllocationPreview[];
  const hasExplicitReceipts = lines.some((line) => Number(line.received_qty ?? 0) > 0);

  const availableByProduct = new Map<string, number>();
  for (const line of lines) {
    const productId = line.product_id ?? null;
    if (!productId) continue;
    const received = Number(line.received_qty ?? 0);
    const fallback = Number(line.ordered_qty ?? line.on_order_qty ?? 0);
    const available = hasExplicitReceipts ? Math.max(received, 0) : Math.max(fallback, 0);
    if (available <= 0) continue;
    availableByProduct.set(productId, (availableByProduct.get(productId) ?? 0) + available);
  }

  const groupedByProduct = new Map<string, ContainerAllocationPreview[]>();
  for (const allocation of allocationRows) {
    if (!allocation.product_id || !allocation.shipping_order_lines?.id) continue;
    const rows = groupedByProduct.get(allocation.product_id) ?? [];
    rows.push(allocation);
    groupedByProduct.set(allocation.product_id, rows);
  }

  const eligibleLineIds = new Set<string>();
  for (const [productId, allocations] of groupedByProduct.entries()) {
    let available = availableByProduct.get(productId) ?? 0;
    if (available <= 0) continue;

    const sorted = [...allocations].sort((a, b) => {
      const aPos = a.shipping_order_lines?.queue_position_start ?? Number.MAX_SAFE_INTEGER;
      const bPos = b.shipping_order_lines?.queue_position_start ?? Number.MAX_SAFE_INTEGER;
      return aPos - bPos;
    });

    for (const allocation of sorted) {
      const line = allocation.shipping_order_lines;
      if (!line?.id) continue;

      if (["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP", "PARTIALLY_FULFILLED", "FULFILLED"].includes(line.warehouse_status ?? "")) {
        continue;
      }

      const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
      if (remainingQty <= 0) continue;

      const allocatedQty = Math.max(0, Number(allocation.quantity ?? 0));
      const requiredQty = Math.min(remainingQty, allocatedQty);
      if (requiredQty <= 0) continue;

      if (available >= requiredQty) {
        eligibleLineIds.add(line.id);
        available -= requiredQty;
      }
    }
  }

  const customerRows = allocationRows
    .map((allocation) => {
      const line = allocation.shipping_order_lines;
      if (!line?.id) return null;

      const customer = line.shipping_orders?.qbo_invoices?.customers?.company_name
        ?? [
          line.shipping_orders?.qbo_invoices?.customers?.first_name,
          line.shipping_orders?.qbo_invoices?.customers?.last_name,
        ].filter(Boolean).join(" ")
        ?? "Customer pending";

      const invoice = line.shipping_orders?.qbo_invoices?.invoice_number ?? "—";
      const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));

      const row: CustomerImpactRow = {
        lineId: line.id,
        orderId: line.shipping_orders?.id ?? "",
        invoice,
        customer,
        sku: line.products?.sku ?? line.products?.canonical_name ?? "SKU pending",
        allocationQty: Math.max(0, Number(allocation.quantity ?? 0)),
        remainingQty,
        queuePosition: line.queue_position_start ?? null,
        currentWarehouse: formatStatus(line.warehouse_status),
        willMarkInWarehouse: eligibleLineIds.has(line.id),
      };

      return row;
    })
    .filter((row): row is CustomerImpactRow => Boolean(row))
    .sort((a, b) => {
      const aPos = a.queuePosition ?? Number.MAX_SAFE_INTEGER;
      const bPos = b.queuePosition ?? Number.MAX_SAFE_INTEGER;
      if (aPos !== bPos) return aPos - bPos;
      return a.customer.localeCompare(b.customer);
    });

  return (
    <div className="space-y-6">
      {query.error ? (
        <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{query.error}</div>
      ) : null}

      {query.success ? (
        <div className="rounded-lg border border-[#d7f7e2] bg-[#f1fdf5] p-3 text-sm text-[#0f6f35]">{query.success}</div>
      ) : null}

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold text-[#111827]">{container.container_number}</h1>
            <p className="mt-2 text-sm text-[#5a5a5a]">Review the product lines, logistics, and payment details for this container.</p>
          </div>
          <Link href="/containers" className="btn-secondary">Back to Containers</Link>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-[#111827]">Customers On This Container</h2>
            <p className="mt-1 text-sm text-[#5a5a5a]">
              Accepting this container marks only applicable allocated lines as In Warehouse based on received quantities.
            </p>
          </div>
          {container.lifecycle_status !== "RECEIVED" ? (
            <form action={acceptContainerToWarehouseAction}>
              <input type="hidden" name="container_id" value={container.id} />
              <button type="submit" className="btn-primary">Mark These As In Warehouse</button>
            </form>
          ) : (
            <span className="rounded-full bg-[#e7f7ed] px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#1b7a43]">
              Already Received
            </span>
          )}
        </div>

        <div className="mt-4 rounded-lg border border-[#dbe5f0] bg-[#f8fbff] p-3 text-sm text-[#334155]">
          <p>
            {eligibleLineIds.size} line(s) will move to In Warehouse now.
          </p>
          <p className="mt-1 text-xs text-[#64748b]">
            Receipt mode: {hasExplicitReceipts ? "using Qty Received from container lines" : "using ordered quantity fallback because Qty Received is empty"}.
          </p>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-[980px] w-full divide-y divide-[#e5e7eb] text-sm">
            <thead className="bg-[#f9fafb] text-left text-[#6b7280]">
              <tr>
                <th className="px-3 py-3 font-semibold">Queue</th>
                <th className="px-3 py-3 font-semibold">Invoice</th>
                <th className="px-3 py-3 font-semibold">Customer</th>
                <th className="px-3 py-3 font-semibold">SKU</th>
                <th className="px-3 py-3 font-semibold">Allocated on Container</th>
                <th className="px-3 py-3 font-semibold">Qty Remaining</th>
                <th className="px-3 py-3 font-semibold">Current Warehouse</th>
                <th className="px-3 py-3 font-semibold">Will Mark In Warehouse</th>
                <th className="px-3 py-3 font-semibold">Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e5e7eb] bg-white">
              {customerRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-[#6b7280]">
                    No customer allocations are currently tied to this container.
                  </td>
                </tr>
              ) : (
                customerRows.map((row, idx) => (
                  <tr key={`${row.lineId}-${idx}`}>
                    <td className="px-3 py-3">{row.queuePosition ?? "—"}</td>
                    <td className="px-3 py-3">{row.invoice}</td>
                    <td className="px-3 py-3 font-medium text-[#111827]">{row.customer}</td>
                    <td className="px-3 py-3">{row.sku}</td>
                    <td className="px-3 py-3">{row.allocationQty}</td>
                    <td className="px-3 py-3">{row.remainingQty}</td>
                    <td className="px-3 py-3">{row.currentWarehouse}</td>
                    <td className="px-3 py-3">
                      {row.willMarkInWarehouse ? (
                        <span className="rounded-full bg-[#e7f7ed] px-2.5 py-1 text-xs font-semibold text-[#1b7a43]">Yes</span>
                      ) : (
                        <span className="rounded-full bg-[#f3f4f6] px-2.5 py-1 text-xs font-semibold text-[#6b7280]">No</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {row.orderId ? <Link href={`/orders/${row.orderId}`} className="text-[#2563eb] hover:underline">Order</Link> : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
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
