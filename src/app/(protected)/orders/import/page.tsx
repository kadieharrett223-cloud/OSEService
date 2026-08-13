import fs from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { bulkImportOrdersAction } from "./actions";

const REPORTS_DIR = path.join(process.cwd(), "tmp", "import-reports");
const PENDING_IMPORTS_DIR = path.join(REPORTS_DIR, "pending");

type SearchParams = {
  error?: string;
  message?: string;
  report?: string;
  mode?: string;
  pending?: string;
};

type PendingDuplicateEntry = {
  invoiceNumber: string;
  importedCustomerNames: string[];
  existingOrders: Array<{
    id: string;
    orderNumber: string | null;
    reviewStatus: string | null;
    customerName: string | null;
    createdAt: string | null;
  }>;
};

type PendingImportSession = {
  stagedPath: string;
  mode: "apply";
  duplicates: PendingDuplicateEntry[];
};

type ImportPreview = {
  sourceRecordCount: number;
  excluded: Record<string, number>;
  eligibleOrderCount: number;
  eligibleLineCount: number;
  totalQty: number;
  suggestedFloorCount?: number;
  suggestedContainerCount?: number;
  unassignedCount?: number;
  unmappedSkuCount?: number;
  unmappedSkus?: string[];
  containerAssignmentMissing?: Array<{
    sourceRecordId: string;
    containerLegacyId: string | null;
    invoiceNumber: string | null;
    itemCode: string | null;
  }>;
  sampleOrders?: Array<{
    invoiceNumber: string | null;
    customerName: string | null;
    lineCount: number;
    qty: number;
  }>;
};

type ImportResults = {
  ordersUpserted: number;
  linesUpserted: number;
  allocationsUpserted: number;
  suggestedContainerAssignments?: number;
  suggestedFloorAssignments?: number;
  linesSkippedUnmappedSku?: string[];
  linesSkippedMissingContainerMapping?: Array<{
    sourceRecordId: string;
    containerLegacyId: string | null;
  }>;
};

type ImportReport = {
  generatedAt: string;
  mode: string;
  input: string;
  preview: ImportPreview;
  results?: ImportResults;
};

async function loadReport(reportName: string | undefined) {
  if (!reportName) return null;
  const safeName = path.basename(reportName);
  if (safeName !== reportName) return null;

  try {
    const raw = await fs.readFile(path.join(REPORTS_DIR, safeName), "utf8");
    return JSON.parse(raw) as ImportReport;
  } catch {
    return null;
  }
}

async function loadPendingImport(token: string | undefined) {
  if (!token) return null;
  const safeToken = path.basename(token);
  if (safeToken !== token) return null;

  try {
    const raw = await fs.readFile(path.join(PENDING_IMPORTS_DIR, safeToken), "utf8");
    return JSON.parse(raw) as PendingImportSession;
  } catch {
    return null;
  }
}

function formatCount(value: number | undefined) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

export default async function OrderImportPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireUser();
  const params = await searchParams;
  const report = await loadReport(params.report);
  const pendingImport = await loadPendingImport(params.pending);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Orders & Shipping</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Bulk Upload Orders</h1>
            <p className="mt-2 max-w-3xl text-sm text-[#5a5a5a]">
              Upload or paste OLD_ERP backlog JSON to preview eligible approved open demand, then apply it into the shipping queue.
              This reuses the existing backlog importer and does not create live inventory allocations.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/orders" className="btn-secondary inline-flex">Back to Orders</Link>
          </div>
        </div>
      </div>

      {params.error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{params.error}</p>
      ) : null}

      {params.message ? (
        <p className="rounded-md border border-[#bfdcc5] bg-[#f3fff6] p-3 text-sm text-[#0f5b28]">{params.message}</p>
      ) : null}

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Import Payload</h2>
        <p className="mt-1 text-sm text-[#5a5a5a]">
          Use the JSON array shape from OLD_ERP queue exports. You can upload a JSON file or paste raw JSON directly.
        </p>
        <div className="mt-3 rounded-lg border border-[#dbe3ee] bg-[#f8fafc] p-3 text-sm text-[#334155]">
          <p className="font-medium text-[#111827]">What this import includes</p>
          <p className="mt-1">
            Only approved, open demand is imported. Denied, removed, fulfilled, shipped, or otherwise closed rows stay out of the apply set.
            Preview and apply use the same filter, and the report shows what was included, excluded, and left unmapped.
          </p>
        </div>
        <form action={bulkImportOrdersAction} className="mt-4 space-y-4">
          <div className="grid gap-4 xl:grid-cols-[1fr_1.4fr]">
            <div className="space-y-2">
              <label htmlFor="payload_file" className="label">JSON File</label>
              <input id="payload_file" name="payload_file" type="file" accept=".json,application/json" className="input h-auto py-2" />
              <p className="text-xs text-[#64748b]">Local sandbox upload only. The file is staged under the ignored imports folder.</p>
            </div>
            <div className="space-y-2">
              <label htmlFor="raw_json" className="label">Or Paste Raw JSON</label>
              <textarea
                id="raw_json"
                name="raw_json"
                rows={12}
                className="textarea font-mono text-xs"
                placeholder='[{"invoiceNumber":"8703","customerName":"Dan Malsch","itemCode":"4PHR-9","qty":1,"approvalStatus":"APPROVED","queueStatus":"APPROVED","id":"..."}]'
              />
            </div>
          </div>

          <div className="rounded-lg border border-[#e5e7eb] bg-[#f8fafc] p-3 text-sm text-[#334155]">
            Preview shows what will import. Apply writes only eligible approved open demand into shipping orders and shipping order lines.
            Denied, removed, fulfilled, and shipped rows stay excluded.
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="submit" name="mode" value="preview" className="btn-secondary">Preview Import</button>
            <button type="submit" name="mode" value="apply" className="btn-primary">Apply Import</button>
          </div>
        </form>
      </section>

      {pendingImport ? (
        <section className="card border border-[#f5c98a] bg-[#fffaf2] p-4 shadow-sm">
          <h2 className="text-xl font-semibold text-[#121826]">Duplicate Invoice Review</h2>
          <p className="mt-1 text-sm text-[#7c4a03]">
            These invoice numbers already exist in shipping orders. Proceed to reuse and update the existing orders, or skip selected invoices before apply.
          </p>

          <form action={bulkImportOrdersAction} className="mt-4 space-y-4">
            <input type="hidden" name="pending_token" value={params.pending ?? ""} />

            <div className="overflow-hidden rounded-lg border border-[#ecd8b2] bg-white">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-[#ececec] text-[#5a5a5a]">
                    <th className="px-3 py-2">Skip</th>
                    <th className="px-3 py-2">Invoice</th>
                    <th className="px-3 py-2">Imported Customer</th>
                    <th className="px-3 py-2">Existing Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingImport.duplicates.map((duplicate) => (
                    <tr key={duplicate.invoiceNumber} className="border-b border-[#f1f5f9] align-top last:border-b-0">
                      <td className="px-3 py-3">
                        <input type="checkbox" name="skip_invoice_numbers" value={duplicate.invoiceNumber} className="h-4 w-4 rounded border-[#cbd5e1]" />
                      </td>
                      <td className="px-3 py-3 font-medium text-[#111827]">{duplicate.invoiceNumber}</td>
                      <td className="px-3 py-3 text-[#334155]">{duplicate.importedCustomerNames.join(", ")}</td>
                      <td className="px-3 py-3 text-[#334155]">
                        <div className="space-y-2">
                          {duplicate.existingOrders.map((existingOrder) => (
                            <div key={existingOrder.id} className="rounded-md border border-[#ececec] bg-[#fafbfc] p-2">
                              <Link href={`/orders/${existingOrder.id}`} className="font-semibold text-[#b20610] hover:underline">
                                Open existing order {existingOrder.orderNumber ? `#${existingOrder.orderNumber}` : ""}
                              </Link>
                              <p className="mt-1 text-xs text-[#5a5a5a]">
                                Customer: {existingOrder.customerName ?? "Unknown"} • Review: {existingOrder.reviewStatus ?? "-"}
                              </p>
                              <p className="text-xs text-[#5a5a5a]">Created: {existingOrder.createdAt ? new Date(existingOrder.createdAt).toLocaleString() : "-"}</p>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="submit" name="duplicate_strategy" value="proceed" className="btn-primary">Proceed And Reuse Existing Orders</button>
              <button type="submit" name="duplicate_strategy" value="skip" className="btn-secondary">Apply And Skip Checked Invoices</button>
            </div>
          </form>
        </section>
      ) : null}

      {report ? (
        <div className="space-y-4">
          <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <article className="card p-3">
              <p className="text-xs text-[#6b7280]">Imported Orders</p>
              <p className="mt-1 text-3xl font-semibold text-[#111827]">{formatCount(report.results?.ordersUpserted ?? report.preview.eligibleOrderCount)}</p>
            </article>
            <article className="card p-3">
              <p className="text-xs text-[#6b7280]">Imported Lines</p>
              <p className="mt-1 text-3xl font-semibold text-[#111827]">{formatCount(report.results?.linesUpserted ?? report.preview.eligibleLineCount)}</p>
            </article>
            <article className="card p-3">
              <p className="text-xs text-[#6b7280]">Excluded Rows</p>
              <p className="mt-1 text-3xl font-semibold text-[#111827]">
                {formatCount(Object.values(report.preview.excluded).reduce((sum, value) => sum + value, 0))}
              </p>
            </article>
            <article className="card p-3">
              <p className="text-xs text-[#6b7280]">Unmapped SKUs</p>
              <p className="mt-1 text-3xl font-semibold text-[#111827]">{formatCount(report.preview.unmappedSkuCount)}</p>
            </article>
          </section>

          <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
            <article className="card p-3">
              <p className="text-xs text-[#6b7280]">Source Records</p>
              <p className="mt-1 text-3xl font-semibold text-[#111827]">{formatCount(report.preview.sourceRecordCount)}</p>
            </article>
            <article className="card p-3">
              <p className="text-xs text-[#6b7280]">Eligible Orders</p>
              <p className="mt-1 text-3xl font-semibold text-[#111827]">{formatCount(report.preview.eligibleOrderCount)}</p>
            </article>
            <article className="card p-3">
              <p className="text-xs text-[#6b7280]">Eligible Lines</p>
              <p className="mt-1 text-3xl font-semibold text-[#111827]">{formatCount(report.preview.eligibleLineCount)}</p>
            </article>
            <article className="card p-3">
              <p className="text-xs text-[#6b7280]">Suggested Container</p>
              <p className="mt-1 text-3xl font-semibold text-[#111827]">{formatCount(report.preview.suggestedContainerCount)}</p>
            </article>
            <article className="card p-3">
              <p className="text-xs text-[#6b7280]">Suggested Floor</p>
              <p className="mt-1 text-3xl font-semibold text-[#111827]">{formatCount(report.preview.suggestedFloorCount)}</p>
            </article>
          </section>

          <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-semibold text-[#121826]">Latest Report</h2>
              <p className="text-sm text-[#5a5a5a]">{report.mode} • {new Date(report.generatedAt).toLocaleString()}</p>
            </div>
            <div className="mt-3 rounded-lg border border-[#dbe3ee] bg-[#f8fafc] p-3 text-sm text-[#334155]">
              <p className="font-medium text-[#111827]">Apply scope</p>
              <p className="mt-1">
                Eligible records are grouped into orders, then written to shipping orders and shipping order lines. These counts show what was imported,
                what was excluded, and what still needs SKU mapping review.
              </p>
            </div>
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-[#111827]">Excluded Counts</h3>
                <div className="mt-2 overflow-hidden rounded-lg border border-[#ececec]">
                  <table className="w-full text-left text-sm">
                    <tbody>
                      {Object.entries(report.preview.excluded).map(([key, value]) => (
                        <tr key={key} className="border-b border-[#f1f5f9] last:border-b-0">
                          <td className="px-3 py-2 text-[#475569]">{key}</td>
                          <td className="px-3 py-2 font-medium text-[#111827]">{formatCount(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-[#111827]">Apply Results</h3>
                <div className="mt-2 overflow-hidden rounded-lg border border-[#ececec]">
                  <table className="w-full text-left text-sm">
                    <tbody>
                      <tr className="border-b border-[#f1f5f9]">
                        <td className="px-3 py-2 text-[#475569]">Orders Upserted</td>
                        <td className="px-3 py-2 font-medium text-[#111827]">{formatCount(report.results?.ordersUpserted)}</td>
                      </tr>
                      <tr className="border-b border-[#f1f5f9]">
                        <td className="px-3 py-2 text-[#475569]">Lines Upserted</td>
                        <td className="px-3 py-2 font-medium text-[#111827]">{formatCount(report.results?.linesUpserted)}</td>
                      </tr>
                      <tr className="border-b border-[#f1f5f9]">
                        <td className="px-3 py-2 text-[#475569]">Suggested Container Assignments</td>
                        <td className="px-3 py-2 font-medium text-[#111827]">{formatCount(report.results?.suggestedContainerAssignments)}</td>
                      </tr>
                      <tr>
                        <td className="px-3 py-2 text-[#475569]">Suggested Floor Assignments</td>
                        <td className="px-3 py-2 font-medium text-[#111827]">{formatCount(report.results?.suggestedFloorAssignments)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-[#111827]">Sample Orders</h3>
                <div className="mt-2 overflow-hidden rounded-lg border border-[#ececec]">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-[#ececec] text-[#5a5a5a]">
                        <th className="px-3 py-2">Invoice</th>
                        <th className="px-3 py-2">Customer</th>
                        <th className="px-3 py-2">Lines</th>
                        <th className="px-3 py-2">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(report.preview.sampleOrders ?? []).map((order) => (
                        <tr key={`${order.invoiceNumber}-${order.customerName}-${order.lineCount}`} className="border-b border-[#f1f5f9] last:border-b-0">
                          <td className="px-3 py-2">{order.invoiceNumber ?? "-"}</td>
                          <td className="px-3 py-2">{order.customerName ?? "-"}</td>
                          <td className="px-3 py-2">{formatCount(order.lineCount)}</td>
                          <td className="px-3 py-2">{formatCount(order.qty)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-[#111827]">Unmapped SKUs</h3>
                <div className="mt-2 rounded-lg border border-[#ececec] bg-[#fafbfc] p-3 text-sm text-[#334155]">
                  {report.preview.unmappedSkus && report.preview.unmappedSkus.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {report.preview.unmappedSkus.map((sku) => (
                        <span key={sku} className="rounded-full bg-white px-2 py-1 text-xs font-medium text-[#334155] ring-1 ring-[#d7dee8]">{sku}</span>
                      ))}
                    </div>
                  ) : (
                    <p>No unmapped SKUs in this report.</p>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}