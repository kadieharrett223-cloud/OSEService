import Link from "next/link";
import { deleteUnusedProductAction } from "@/app/(protected)/inventory/actions";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type SearchParams = Promise<{ q?: string; message?: string; error?: string }>;

export default async function ProductsCatalogPage({ searchParams }: { searchParams: SearchParams }) {
  await requireUser();
  const params = await searchParams;
  const query = (params.q ?? "").trim();
  const supabase = getSupabaseAdmin();
  const { data: products, error } = query
    ? await supabase
      .from("products")
      .select("id,sku,canonical_name,status")
      .or(`sku.ilike.%${query}%,canonical_name.ilike.%${query}%`)
      .order("sku")
      .limit(50)
    : { data: [], error: null };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">Products / Catalog</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">Search a canonical product before permanently deleting an unused catalog record.</p>
      </div>
      <form className="rounded-2xl border border-[#e5e7eb] bg-white p-5 shadow-sm">
        <label htmlFor="catalog-search" className="block text-sm font-semibold text-[#334155]">SKU or product name</label>
        <div className="mt-2 flex gap-2"><input id="catalog-search" name="q" defaultValue={query} className="input flex-1" placeholder="e.g. 4PXW-10B" /><button type="submit" className="btn-primary">Search</button><Link href="/products" className="btn-secondary">Clear</Link></div>
      </form>
      {params.message ? <p className="rounded-md border border-[#bbf7d0] bg-[#f0fdf4] p-3 text-sm text-[#166534]">{params.message}</p> : null}
      {params.error || error ? <p className="rounded-md border border-[#fecaca] bg-[#fff1f2] p-3 text-sm text-[#991b1b]">{params.error ?? error?.message}</p> : null}
      {query ? (
        <section className="overflow-hidden rounded-2xl border border-[#e5e7eb] bg-white shadow-sm">
          <table className="w-full text-left text-sm"><thead className="bg-[#f8fafc] text-xs uppercase tracking-[0.08em] text-[#64748b]"><tr><th className="px-4 py-3">SKU</th><th className="px-4 py-3">Product</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Action</th></tr></thead><tbody>
            {(products ?? []).map((product) => <tr key={product.id} className="border-t border-[#f1f5f9]"><td className="px-4 py-3 font-semibold">{product.sku}</td><td className="px-4 py-3">{product.canonical_name}</td><td className="px-4 py-3">{product.status}</td><td className="px-4 py-3"><form action={deleteUnusedProductAction}><input type="hidden" name="product_id" value={product.id} /><button type="submit" className="rounded-lg border border-[#dc2626] px-3 py-1.5 text-xs font-semibold text-[#b91c1c] hover:bg-[#fff1f2]">Permanently delete unused product</button></form></td></tr>)}
            {(products ?? []).length === 0 ? <tr><td colSpan={4} className="px-4 py-8 text-center text-[#64748b]">No catalog products match this search.</td></tr> : null}
          </tbody></table>
        </section>
      ) : null}
    </div>
  );
}
