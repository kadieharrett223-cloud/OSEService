import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import { canonicalSkuKey } from "@/lib/products/canonical-sku";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type ProductRow = { id: string; sku: string | null; canonical_name: string | null };
type AliasRow = { product_id: string | null; alias: string | null };
type InventoryTransaction = {
  id: string;
  product_id: string;
  bucket: string;
  delta: number;
  before_qty: number;
  after_qty: number;
  reason: string;
  source_type: string;
  source_event_key: string | null;
  actor_id: string | null;
  created_at: string;
};

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" });
}

export default async function InventoryAuditPage({ searchParams }: { searchParams: Promise<{ sku?: string }> }) {
  const user = await requireUser();
  if (!await isAdminUnlockedForUser(user.id)) {
    redirect("/inventory?mapError=Admin+mode+is+required+to+view+inventory+audit+history");
  }
  const requestedSku = String((await searchParams).sku ?? "2PBP-8").trim().toUpperCase();
  const targetKey = canonicalSkuKey(requestedSku);
  const supabase = getSupabaseAdmin();
  const [{ data: products, error: productError }, { data: aliases, error: aliasError }] = await Promise.all([
    supabase.from("products").select("id,sku,canonical_name").neq("status", "Inactive"),
    supabase.from("product_aliases").select("product_id,alias"),
  ]);
  if (productError || aliasError) throw new Error(productError?.message ?? aliasError?.message ?? "Could not load inventory identities");

  const aliasKeysByProduct = new Map<string, Set<string>>();
  for (const alias of (aliases ?? []) as AliasRow[]) {
    if (!alias.product_id || !alias.alias) continue;
    const keys = aliasKeysByProduct.get(alias.product_id) ?? new Set<string>();
    keys.add(canonicalSkuKey(alias.alias));
    aliasKeysByProduct.set(alias.product_id, keys);
  }
  const matchedProducts = ((products ?? []) as ProductRow[]).filter((product) => (
    canonicalSkuKey(product.sku) === targetKey || aliasKeysByProduct.get(product.id)?.has(targetKey)
  ));
  const productIds = matchedProducts.map((product) => product.id);
  const { data: attempts, error: attemptError } = productIds.length
    ? await supabase.from("audit_log").select("id,entity_id,created_at,details")
      .eq("entity_type", "product").eq("action", "STOCK_EDIT_ATTEMPT")
      .in("entity_id", productIds).order("created_at", { ascending: false })
    : { data: [], error: null };
  if (attemptError) throw new Error(attemptError.message);
  const { data: transactions, error: transactionError } = productIds.length
    ? await supabase
      .from("inventory_transactions")
      .select("id,product_id,bucket,delta,before_qty,after_qty,reason,source_type,source_event_key,actor_id,created_at")
      .in("product_id", productIds)
      .order("created_at", { ascending: false })
    : { data: [], error: null };
  if (transactionError) throw new Error(transactionError.message);

  const productById = new Map(matchedProducts.map((product) => [product.id, product]));
  const rows = (transactions ?? []) as InventoryTransaction[];
  const onFloorByProduct = new Map<string, number>();
  for (const row of rows) {
    if (row.bucket !== "ON_FLOOR") continue;
    onFloorByProduct.set(row.product_id, (onFloorByProduct.get(row.product_id) ?? 0) + Number(row.delta ?? 0));
  }

  return (
    <main className="mx-auto max-w-7xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">Inventory / Ledger Audit</p>
          <h1 className="text-3xl font-bold">Read-only stock trace</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">This page reports existing ledger entries only. It cannot adjust stock, fulfill an order, sync QuickBooks, or alter customer queues.</p>
        </div>
        <Link href="/inventory" className="rounded border px-4 py-2 text-sm font-medium">Back to Inventory</Link>
      </div>

      <form className="mb-6 flex max-w-lg gap-2" action="/inventory/audit">
        <label className="sr-only" htmlFor="sku">SKU</label>
        <input id="sku" name="sku" defaultValue={requestedSku} className="min-w-0 flex-1 rounded border px-3 py-2" />
        <button className="rounded bg-slate-900 px-4 py-2 font-medium text-white">Trace SKU</button>
      </form>

      <section className="mb-6 rounded border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold">Stock edit attempts (including no changes)</h2>
        <p className="mt-1 text-sm text-slate-600">These are audit records, not stock movements. They never add to or subtract from inventory.</p>
        {(attempts ?? []).map((attempt) => {
          const details = attempt.details as { actor_name?: string; displayed_qty?: number | null; current_qty?: number; requested_qty?: number; reason?: string; outcome?: string } | null;
          return <article key={attempt.id} className="mt-3 rounded border p-3 text-sm">
            <p>{displayDate(attempt.created_at)} · {details?.actor_name ?? "Admin"} · {details?.outcome ?? "Unknown"}</p>
            <p>Displayed: {details?.displayed_qty ?? "unknown"} · Ledger: {details?.current_qty} · Requested: {details?.requested_qty}</p>
            <p>{details?.reason}</p>
            <p className="font-mono text-xs text-slate-500">Product ID: {attempt.entity_id}</p>
          </article>;
        })}
        {!attempts?.length ? <p className="mt-3 text-sm text-slate-500">No recorded edit attempts. Earlier no-change attempts were not logged and cannot be reconstructed.</p> : null}
      </section>

      <section className="rounded border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold">{requestedSku}</h2>
        {matchedProducts.length === 0 ? <p className="mt-3 text-sm text-amber-700">No active product or alias identity matched this SKU.</p> : (
          <div className="mt-4 space-y-6">
            {matchedProducts.map((product) => {
              const productRows = rows.filter((row) => row.product_id === product.id);
              return (
                <article key={product.id} className="rounded border p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h3 className="font-semibold">{product.sku ?? "No SKU"}</h3>
                      <p className="text-sm text-slate-600">{product.canonical_name ?? "Unnamed product"}</p>
                      <p className="mt-1 font-mono text-xs text-slate-500">Product ID: {product.id}</p>
                    </div>
                    <p className="rounded bg-slate-100 px-3 py-1 text-sm font-semibold">On-floor ledger total: {onFloorByProduct.get(product.id) ?? 0}</p>
                  </div>
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b text-xs uppercase text-slate-500"><tr><th className="p-2">When</th><th className="p-2">Bucket</th><th className="p-2">Delta</th><th className="p-2">Before → After</th><th className="p-2">Source</th><th className="p-2">Reason</th></tr></thead>
                      <tbody>
                        {productRows.map((row) => <tr className="border-b align-top" key={row.id}>
                          <td className="p-2 whitespace-nowrap">{displayDate(row.created_at)}</td>
                          <td className="p-2">{row.bucket}</td>
                          <td className={`p-2 font-semibold ${row.delta > 0 ? "text-emerald-700" : row.delta < 0 ? "text-red-700" : ""}`}>{row.delta > 0 ? "+" : ""}{row.delta}</td>
                          <td className="p-2 whitespace-nowrap">{row.before_qty} → {row.after_qty}</td>
                          <td className="p-2"><div>{row.source_type}</div><div className="font-mono text-xs text-slate-500">{row.source_event_key ?? "—"}</div></td>
                          <td className="p-2"><div>{row.reason}</div>{row.actor_id ? <div className="font-mono text-xs text-slate-500">Actor: {row.actor_id}</div> : null}</td>
                        </tr>)}
                        {productRows.length === 0 ? <tr><td className="p-3 text-slate-500" colSpan={6}>No ledger rows found for this identity.</td></tr> : null}
                      </tbody>
                    </table>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
