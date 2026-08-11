import Link from "next/link";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import { createContainerAction } from "./actions";
import { AddContainerModal } from "./add-container-modal";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getEtaDisplay(container: {
  entered_date: string | null;
  eta_confirmed_date: string | null;
  eta_estimated_date: string | null;
}) {
  if (container.eta_confirmed_date) {
    return {
      label: formatDate(container.eta_confirmed_date),
      isEstimate: false,
    };
  }

  const baseDate = container.entered_date ? new Date(container.entered_date) : null;
  if (baseDate && !Number.isNaN(baseDate.getTime())) {
    const estimated = new Date(baseDate);
    estimated.setDate(estimated.getDate() + 75);
    return {
      label: formatDate(estimated.toISOString()),
      isEstimate: true,
    };
  }

  if (container.eta_estimated_date) {
    return {
      label: formatDate(container.eta_estimated_date),
      isEstimate: true,
    };
  }

  return {
    label: "Pending",
    isEstimate: false,
  };
}

export default async function ContainersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const params = await searchParams;

  const [{ data: containers, error: containersError }, { data: products }] = await Promise.all([
    supabase
      .from("containers")
      .select(`
        id,
        container_number,
        supplier,
        order_date,
        entered_date,
        payment_status,
        lifecycle_status,
        tracking_number,
        eta_confirmed_date,
        eta_estimated_date,
        remaining_balance,
        notes,
        container_lines (
          id,
          ordered_qty,
          received_qty,
          product_id,
          products (sku, canonical_name)
        )
      `)
      .in("lifecycle_status", ["ORDERED", "PRODUCTION", "INBOUND", "RECEIVED"])
      .order("entered_date", { ascending: false }),
    supabase
      .from("products")
      .select("sku")
      .order("sku", { ascending: true }),
  ]);

  const skuOptions = (products ?? [])
    .map((row) => String((row as { sku?: string | null }).sku ?? "").trim().toUpperCase())
    .filter(Boolean);

  const errorMessage = containersError ? "Unable to load container data right now." : params.error ? params.error : null;
  const successMessage = params.success ? params.success : null;
  const incomingContainers = (containers ?? []).filter((container) => {
    const lifecycle = (container as { lifecycle_status?: string | null }).lifecycle_status;
    return lifecycle && ["ORDERED", "PRODUCTION", "INBOUND"].includes(lifecycle);
  });
  const receivedContainers = (containers ?? []).filter((container) => (container as { lifecycle_status?: string | null }).lifecycle_status === "RECEIVED");

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold text-[#111827]">Containers</h1>
            <p className="mt-2 text-sm text-[#5a5a5a]">
              Review incoming inventory, logistics, and product detail for each container without changing the service workflow.
            </p>
          </div>
          <AddContainerModal createAction={createContainerAction} productSkus={skuOptions} />
        </div>
      </div>

      {errorMessage ? (
        <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{errorMessage}</div>
      ) : null}

      {successMessage ? (
        <div className="rounded-lg border border-[#d7f7e2] bg-[#f1fdf5] p-3 text-sm text-[#0f6f35]">{successMessage}</div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Incoming / Active</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{incomingContainers.length}</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Received</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{receivedContainers.length}</p>
        </div>
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-[#6b7280]">Container contents</p>
          <p className="mt-2 text-3xl font-semibold text-[#111827]">{(containers ?? []).reduce((sum, entry) => sum + ((entry as { container_lines?: Array<{ ordered_qty: number | null }> }).container_lines?.length ?? 0), 0)}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-[#111827]">Active Containers</h2>
          <p className="text-sm text-[#6b7280]">Incoming quantities remain visible before the container is received, and received containers stay available for review.</p>
        </div>

        {containers && containers.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[#e5e7eb] text-sm">
              <thead className="bg-[#f9fafb] text-left text-[#6b7280]">
                <tr>
                  <th className="px-3 py-3 font-semibold">Container #</th>
                  <th className="px-3 py-3 font-semibold">Supplier</th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <th className="px-3 py-3 font-semibold">Order / Entered</th>
                  <th className="px-3 py-3 font-semibold">Tracking / ETA</th>
                  <th className="px-3 py-3 font-semibold">Products / Units</th>
                  <th className="px-3 py-3 font-semibold">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e5e7eb] bg-white">
                {containers.map((container) => {
                  const typedContainer = container as {
                    id: string;
                    container_number: string;
                    supplier: string | null;
                    order_date: string | null;
                    entered_date: string | null;
                    payment_status: string | null;
                    lifecycle_status: string;
                    tracking_number: string | null;
                    eta_confirmed_date: string | null;
                    eta_estimated_date: string | null;
                    remaining_balance: number | null;
                    notes: string | null;
                    container_lines?: Array<{ ordered_qty: number | null }>;
                  };
                  const eta = getEtaDisplay(typedContainer);
                  const lineCount = typedContainer.container_lines?.length ?? 0;
                  const totalUnits = (typedContainer.container_lines ?? []).reduce((sum, line) => sum + Number(line.ordered_qty ?? 0), 0);
                  const productSummary = (typedContainer.container_lines ?? [])
                    .map((line) => (line as { products?: { sku?: string | null } }).products?.sku)
                    .filter((sku): sku is string => Boolean(sku))
                    .slice(0, 3)
                    .join(", ");

                  return (
                    <tr key={typedContainer.id} className="align-top">
                      <td className="px-3 py-3 font-medium text-[#111827]">{typedContainer.container_number}</td>
                      <td className="px-3 py-3 text-[#374151]">{typedContainer.supplier ?? "—"}</td>
                      <td className="px-3 py-3">
                        <span className="rounded-full bg-[#eef2f7] px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-[#334155]">
                          {typedContainer.lifecycle_status}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-[#374151]">
                        <div>{formatDate(typedContainer.order_date)}</div>
                        <div className="text-xs text-[#6b7280]">{formatDate(typedContainer.entered_date)}</div>
                      </td>
                      <td className="px-3 py-3 text-[#374151]">
                        <div>{typedContainer.tracking_number ?? "—"}</div>
                        <div className="text-xs text-[#6b7280]">
                          {eta.isEstimate ? (
                            <span className="font-medium text-[#92400e]">Est. {eta.label}</span>
                          ) : (
                            <span>{eta.label}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-[#374151]">
                        <div>{lineCount} line{lineCount === 1 ? "" : "s"}</div>
                        <div className="text-xs text-[#6b7280]">{totalUnits} total units</div>
                        <div className="mt-2 text-xs text-[#6b7280]">{productSummary || "No SKU lines yet"}</div>
                      </td>
                      <td className="px-3 py-3">
                        <Link href={`/containers/${typedContainer.id}`} className="btn-secondary inline-flex">Open / View Details</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-6 text-sm text-[#6b7280]">
            No active containers are available yet. Use the form below to add the first container.
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-[#111827]">Received Containers</h2>
        <p className="mt-1 text-sm text-[#5a5a5a]">These keep the historical inventory movement visible without forcing extra manual steps.</p>

        {receivedContainers.length > 0 ? (
          <div className="mt-4 space-y-3">
            {receivedContainers.slice(0, 6).map((container) => {
              const typedContainer = container as {
                id: string;
                container_number: string;
                supplier: string | null;
                lifecycle_status: string;
                entered_date: string | null;
                eta_confirmed_date: string | null;
                eta_estimated_date: string | null;
              };
              const eta = getEtaDisplay(typedContainer);
              return (
                <div key={typedContainer.id} className="rounded-xl border border-[#e5e7eb] bg-[#fafbfc] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-[#111827]">{typedContainer.container_number}</p>
                      <p className="text-sm text-[#5a5a5a]">{typedContainer.supplier ?? "Supplier pending"}</p>
                    </div>
                    <div className="text-sm text-[#374151]">
                      <p>Entered {formatDate(typedContainer.entered_date)}</p>
                      <p className="mt-1">ETA {eta.label}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] p-5 text-sm text-[#6b7280]">
            No received containers have been marked yet.
          </div>
        )}
      </div>

    </div>
  );
}
