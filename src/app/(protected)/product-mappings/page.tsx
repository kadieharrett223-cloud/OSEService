import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createFocusedProductMappingAction, resolveProductMappingForSkuAction } from "./actions";
import { ProductPicker } from "./product-picker";

type SearchParams = Promise<{ message?: string; error?: string; source_sku?: string; source_description?: string; order_id?: string }>;
type MappingQueueRow = {
  id: string;
  source_sku: string;
  source_description: string | null;
  customer_name: string | null;
  invoice_number: string | null;
  quantity: number;
  current_product_id: string | null;
  status: string;
  resolution_note: string | null;
};
type ProductRow = { id: string; sku: string; canonical_name: string };
type MappingGroup = {
  id: string;
  source_sku: string;
  source_description: string | null;
  customer_name: string | null;
  invoice_number: string | null;
  quantity: number;
  current_product_id: string | null;
};

export default async function ProductMappingsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireUser();
  const params = await searchParams;
  const supabase = getSupabaseAdmin();
  const focusedSourceSku = String(params.source_sku ?? "").trim().toUpperCase();
  const focusedDescription = String(params.source_description ?? "").trim();
  const [{ data: rawQueueRows, error: queueError }, { data: rawProducts, error: productsError }] = await Promise.all([
    supabase
      .from("manual_product_mapping_queue")
      .select("id, source_sku, source_description, customer_name, invoice_number, quantity, current_product_id, status, resolution_note")
      .eq("status", "OPEN")
      .order("created_at", { ascending: true }),
    supabase.from("products").select("id, sku, canonical_name").eq("status", "Active").order("sku"),
  ]);
  const queueRows = (rawQueueRows as unknown as MappingQueueRow[] | null)?.filter((entry) => !focusedSourceSku || entry.source_sku.trim().toUpperCase() === focusedSourceSku) ?? null;
  const products = rawProducts as unknown as ProductRow[] | null;
  const mappingGroups = Array.from((queueRows ?? []).reduce((groups, entry) => {
    const key = entry.source_sku.trim().toUpperCase();
    const existing = groups.get(key);
    if (existing) {
      existing.source_description = existing.source_description ?? entry.source_description;
      existing.customer_name = [existing.customer_name, entry.customer_name].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(", ") || null;
      existing.invoice_number = [existing.invoice_number, entry.invoice_number].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(", ") || null;
      existing.quantity += Number(entry.quantity ?? 0);
      return groups;
    }
    groups.set(key, {
      id: entry.id,
      source_sku: entry.source_sku,
      source_description: entry.source_description,
      customer_name: entry.customer_name,
      invoice_number: entry.invoice_number,
      quantity: Number(entry.quantity ?? 0),
      current_product_id: entry.current_product_id,
    });
    return groups;
  }, new Map<string, MappingGroup>())).map(([, group]) => group);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-[#d50917]">Migration Exceptions</p>
        <h1 className="mt-2 text-3xl font-semibold text-[#111827]">Manual Product Mapping</h1>
        <p className="mt-2 max-w-3xl text-sm text-[#5a5a5a]">
          Resolve only the product identities held out of the validated migration. Saving a mapping does not move inventory or change an order until its affected rows are reconciled.
        </p>
      </section>

      {focusedSourceSku ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#f1d3a4] bg-[#fff8ec] p-3 text-sm text-[#915b12]">
          <span>Showing the QuickBooks item that needs mapping: <strong>{focusedSourceSku}</strong></span>
          {params.order_id ? <a href={`/orders/${encodeURIComponent(params.order_id)}`} className="btn-secondary text-xs">Back to order</a> : null}
        </div>
      ) : null}

      {params.message ? <div className="rounded-lg border border-[#b7e4c7] bg-[#ecfdf3] p-3 text-sm text-[#166534]">{params.message}</div> : null}
      {params.error ? <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{params.error}</div> : null}
      {queueError || productsError ? <div className="rounded-lg border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">Manual mapping queue is unavailable until its migration is applied.</div> : null}

      <div className="overflow-x-auto rounded-2xl border border-[#e5e7eb] bg-white shadow-sm">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="bg-[#f8fafc]">
            <tr className="border-b border-[#e5e7eb] text-xs font-semibold uppercase tracking-[0.06em] text-[#64748b]">
              <th className="px-4 py-3">Source SKU</th>
              <th className="px-4 py-3">Description</th>
              <th className="px-4 py-3">Customer / Invoice</th>
              <th className="px-4 py-3">Qty</th>
              <th className="px-4 py-3">Current Mapping</th>
              <th className="px-4 py-3">Select Correct Product</th>
              <th className="px-4 py-3">Save</th>
            </tr>
          </thead>
          <tbody>
            {mappingGroups.map((entry) => (
              <tr key={entry.id} className="border-b border-[#f1f5f9] align-top last:border-0">
                <td className="px-4 py-4 font-semibold text-[#111827]">{entry.source_sku}</td>
                <td className="max-w-[320px] px-4 py-4 text-[#475569]">{entry.source_description ?? "—"}</td>
                <td className="px-4 py-4 text-[#475569]">{entry.customer_name ?? "—"}<div className="text-xs">Invoice {entry.invoice_number ?? "—"}</div></td>
                <td className="px-4 py-4 font-semibold">{entry.quantity}</td>
                <td className="px-4 py-4 text-xs text-[#64748b]">{entry.current_product_id ?? "Unmapped / ambiguous"}</td>
                <td className="px-4 py-4">
                  <form id={`mapping-${entry.id}`} action={resolveProductMappingForSkuAction} className="space-y-2">
                    <input type="hidden" name="sourceSku" value={entry.source_sku} />
                    {params.order_id ? <input type="hidden" name="returnTo" value={`/orders/${params.order_id}`} /> : null}
                    <ProductPicker products={products ?? []} />
                    <input name="resolutionNote" placeholder="Reason / evidence (optional)" className="input min-w-[280px]" />
                  </form>
                </td>
                <td className="px-4 py-4"><button form={`mapping-${entry.id}`} type="submit" className="btn-primary">Save</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!mappingGroups.length ? <p className="p-6 text-sm text-[#64748b]">No open manual mappings are queued.</p> : null}
      </div>

      {focusedSourceSku && !queueRows?.length ? (
        <section className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-[#111827]">Map This QuickBooks Item</h2>
          <p className="mt-1 text-sm text-[#5a5a5a]">{focusedSourceSku}{focusedDescription ? ` — ${focusedDescription}` : ""}</p>
          <form action={createFocusedProductMappingAction} className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <input type="hidden" name="sourceSku" value={focusedSourceSku} />
            {params.order_id ? <input type="hidden" name="returnTo" value={`/orders/${params.order_id}`} /> : null}
            <label className="text-xs font-semibold text-[#64748b]">Select the matching inventory item<ProductPicker products={products ?? []} /></label>
            <button type="submit" className="btn-primary">Save Mapping</button>
          </form>
        </section>
      ) : null}
    </div>
  );
}