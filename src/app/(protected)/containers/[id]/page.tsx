import Link from "next/link";
import { notFound } from "next/navigation";
import { updateContainerArrivalDatesAction } from "@/app/(protected)/containers/actions";
import { requireUser } from "@/lib/auth";
import { loadContainerReceipt } from "@/lib/containers/container-coverage";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ReceiveContainerWorkspace } from "./receive-container-workspace";

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

function toDateInputValue(value: string | null | undefined) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
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
  await requireUser();
  const supabase = getSupabaseAdmin();

  const [{ data: containerData, error }, coverage] = await Promise.all([
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
    loadContainerReceipt(supabase, id),
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

  const allocatedByProduct = new Map<string, number>();
  for (const row of coverage.rows) {
    if (row.coveredQty <= 0) continue;
    allocatedByProduct.set(row.productId, (allocatedByProduct.get(row.productId) ?? 0) + row.coveredQty);
  }

  const isReceived = coverage.isReceived;
  const eligibleLineIds = coverage.eligibleLineIds;
  const customerRows = isReceived
    ? coverage.rows.map((row) => ({ ...row, containerQty: row.coveredQty, stockCovered: row.willMarkInWarehouse }))
    : coverage.forecastRows
        .filter((row) => row.forecastQty > 0)
        .map((row) => ({ ...row, containerQty: row.forecastQty, stockCovered: false }));
  const customerUnits = customerRows.reduce((sum, row) => sum + row.containerQty, 0);
  const receivedQtyByProduct = new Map(coverage.lines.map((line) => [line.productId, line.receivedQty]));
  const expectedTotal = coverage.lines.reduce((sum, line) => sum + line.expectedQty, 0);
  const receivedTotal = coverage.lines.reduce((sum, line) => sum + line.receivedQty, 0);

  const { data: productOptionRows } = isReceived
    ? { data: [] }
    : await supabase.from("products").select("id, sku, canonical_name").order("sku", { ascending: true });

  const manifestProductIds = new Set(coverage.lines.map((line) => line.productId));
  const productOptions = ((productOptionRows ?? []) as Array<{ id: string; sku: string | null; canonical_name: string | null }>)
    .filter((product) => !manifestProductIds.has(product.id))
    .map((product) => ({ id: product.id, sku: product.sku, name: product.canonical_name }));

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
            <p className="mt-2 text-sm text-[#5a5a5a]">Review the product lines and logistics details for this container.</p>
          </div>
          <Link href="/containers" className="btn-secondary">Back to Containers</Link>
        </div>
      </div>

      {!isReceived ? (
        <ReceiveContainerWorkspace
          containerId={container.id}
          containerNumber={container.container_number}
          lines={coverage.lines.map((line) => ({
            id: line.id,
            productId: line.productId,
            sku: line.sku,
            productName: line.productName,
            expectedQty: line.expectedQty,
            assignedQty: line.assignedQty,
            forecastCoverageQty: line.forecastCoverageQty,
            demandQty: line.demandQty,
            isUnplanned: line.isUnplanned,
          }))}
          demandByProduct={coverage.demandByProduct}
          productOptions={productOptions}
        />
      ) : (
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold text-[#111827]">Receipt Reconciliation</h2>
              <p className="mt-1 text-sm text-[#5a5a5a]">Actual received counts are authoritative and are retained for audit.</p>
            </div>
            <span className="rounded-full bg-[#e7f7ed] px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#1b7a43]">
              Received
            </span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Expected units</p><p className="text-2xl font-bold text-[#111827]">{expectedTotal}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Received units</p><p className="text-2xl font-bold text-[#111827]">{receivedTotal}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Variance</p><p className={`text-2xl font-bold ${receivedTotal - expectedTotal < 0 ? "text-[#b91c1c]" : receivedTotal - expectedTotal > 0 ? "text-[#b45309]" : "text-[#111827]"}`}>{receivedTotal - expectedTotal > 0 ? "+" : ""}{receivedTotal - expectedTotal}</p></div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[720px] w-full divide-y divide-[#e5e7eb] text-sm">
              <thead className="bg-[#f9fafb] text-left text-[#6b7280]">
                <tr>
                  <th className="px-3 py-3 font-semibold">SKU</th>
                  <th className="px-3 py-3 font-semibold">Product</th>
                  <th className="px-3 py-3 font-semibold">Expected</th>
                  <th className="px-3 py-3 font-semibold">Received</th>
                  <th className="px-3 py-3 font-semibold">Variance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e5e7eb] bg-white">
                {coverage.lines.map((line) => {
                  const variance = line.receivedQty - line.expectedQty;
                  const isMissing = line.receivedQty === 0 && line.expectedQty > 0;
                  return (
                    <tr key={line.id}>
                      <td className="px-3 py-3 font-medium text-[#111827]">
                        {line.sku}
                        {line.isUnplanned ? (
                          <span className="ml-2 rounded-full bg-[#fff7e6] px-2 py-0.5 text-[11px] font-semibold text-[#b45309]">Unplanned</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-[#4b5563]">{line.productName}</td>
                      <td className="px-3 py-3">{line.expectedQty}</td>
                      <td className="px-3 py-3">{line.receivedQty}</td>
                      <td className="px-3 py-3">
                        {variance === 0 ? (
                          <span className="rounded-full bg-[#f3f4f6] px-2.5 py-1 text-xs font-semibold text-[#4b5563]">Match</span>
                        ) : variance < 0 ? (
                          <span className="rounded-full bg-[#fee2e2] px-2.5 py-1 text-xs font-semibold text-[#b91c1c]">{variance} {isMissing ? "MISSING" : "SHORT"}</span>
                        ) : (
                          <span className="rounded-full bg-[#fff7e6] px-2.5 py-1 text-xs font-semibold text-[#b45309]">+{variance} EXTRA</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-semibold text-[#111827]">Customers On This Container</h2>
            <p className="mt-1 text-sm text-[#5a5a5a]">
              {isReceived
                ? "Coverage below reflects the quantities actually received. Moving an order to In Warehouse stays a manual step."
                : "Forecast based on expected quantities. Final coverage is calculated from the counts you record above."}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-[#dbe5f0] bg-[#f8fbff] p-3 text-sm text-[#334155]">
          <p>
            {isReceived
              ? `${eligibleLineIds.size} order line(s) have stock covered by this container. ${customerRows.filter((row) => !row.stockCovered).length} line(s) remain waiting.`
              : `Based on expected quantities, ${customerRows.length} customer line(s) are forecast to receive ${customerUnits} unit(s) from this container.`}
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
                <th className="px-3 py-3 font-semibold">Covered by Container</th>
                <th className="px-3 py-3 font-semibold">Qty Remaining</th>
                <th className="px-3 py-3 font-semibold">Current Warehouse</th>
                <th className="px-3 py-3 font-semibold">Stock Covered</th>
                <th className="px-3 py-3 font-semibold">Open</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e5e7eb] bg-white">
              {customerRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-[#6b7280]">
                    No open customer orders are waiting on the products in this container.
                  </td>
                </tr>
              ) : (
                customerRows.map((row, idx) => (
                  <tr key={`${row.lineId}-${idx}`} className="bg-[#f8fbff]">
                    <td className="px-3 py-3">{row.queuePosition ?? "—"}</td>
                    <td className="px-3 py-3">{row.invoice}</td>
                    <td className="px-3 py-3 font-medium text-[#111827]">
                      {row.customer}
                      {row.isAssigned ? (
                        <span className="ml-2 rounded-full bg-[#eef2ff] px-2 py-0.5 text-[11px] font-semibold text-[#3730a3]">Assigned</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">{row.sku}</td>
                    <td className="px-3 py-3">{row.containerQty}</td>
                    <td className="px-3 py-3">{row.remainingQty}</td>
                    <td className="px-3 py-3">{row.currentWarehouse}</td>
                    <td className="px-3 py-3">
                      {row.stockCovered ? (
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
                  <th className="px-3 py-3 font-semibold">Expected</th>
                  <th className="px-3 py-3 font-semibold">Qty Received</th>
                  <th className="px-3 py-3 font-semibold">{isReceived ? "Allocated" : "Forecast Allocated"}</th>
                  <th className="px-3 py-3 font-semibold">{isReceived ? "Available to Sell" : "Forecast Available"}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e5e7eb] bg-white">
                {lines.length > 0 ? lines.map((line) => {
                  const ordered = Number(line.ordered_qty ?? 0) || Number(line.on_order_qty ?? 0);
                  const received = line.product_id ? receivedQtyByProduct.get(line.product_id) ?? 0 : 0;
                  const allocated = isReceived
                    ? line.product_id ? allocatedByProduct.get(line.product_id) ?? 0 : 0
                    : coverage.lines.find((coverageLine) => coverageLine.id === line.id)?.forecastCoverageQty ?? 0;
                  const available = isReceived
                    ? Math.max(received - allocated, 0)
                    : Math.max(ordered - allocated, 0);

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

            <form action={updateContainerArrivalDatesAction} className="mt-5 border-t border-[#e5e7eb] pt-4">
              <input type="hidden" name="container_id" value={container.id} />
              <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#6b7280]">Update Arrival Dates</p>
              <p className="mt-1 text-xs text-[#6b7280]">Drives Next Arrival on the Inventory page.</p>
              <div className="mt-3 space-y-3">
                <div>
                  <label className="label" htmlFor="port_date">Port Date</label>
                  <input id="port_date" name="port_date" type="date" className="input" defaultValue={toDateInputValue(container.port_date)} />
                </div>
                <div>
                  <label className="label" htmlFor="eta_confirmed_date">Confirmed ETA</label>
                  <input id="eta_confirmed_date" name="eta_confirmed_date" type="date" className="input" defaultValue={toDateInputValue(container.eta_confirmed_date)} />
                </div>
                <div>
                  <label className="label" htmlFor="eta_estimated_date">Estimated ETA</label>
                  <input id="eta_estimated_date" name="eta_estimated_date" type="date" className="input" defaultValue={toDateInputValue(container.eta_estimated_date)} />
                </div>
              </div>
              <button type="submit" className="mt-4 w-full rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#1f2937]">
                Save Dates
              </button>
            </form>
          </div>

          <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-[#111827]">Logistics</h2>
            <dl className="mt-4 space-y-3 text-sm text-[#374151]">
              <div className="flex justify-between gap-4">
                <dt className="font-medium text-[#6b7280]">Payment Status</dt>
                <dd>{container.payment_status ?? "—"}</dd>
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
