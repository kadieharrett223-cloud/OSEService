import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { inventoryAuditPeriod } from "@/lib/inventory/audit-period";
import { fetchQueuePages } from "@/lib/demand/queue-query-pages";
import { loadCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-loader";
import { auditProductScope, auditCurrentFloor, auditRowsInPeriod, auditFulfillmentMovements, type AuditRoute } from "@/lib/inventory/audit-history";
import { PrintAuditButton } from "./print-audit-button";
import { AuditRefresh } from "./audit-refresh";
import "./audit-print.css";

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

type FulfillmentRow = {
  id: string; shipping_order_line_id: string; fulfilled_qty: number; fulfilled_at: string; created_at: string;
  fulfillment_type: string; source_event_key: string | null; carrier: string | null; tracking_number: string | null;
  shipping_order_lines: { product_id: string; shipping_order_id: string; shipping_orders: {
    order_number: string; customers: { full_name: string | null; company_name: string | null } | null;
  } | null };
};

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "medium" });
}

export default async function InventoryAuditPage({ searchParams }: { searchParams: Promise<{ sku?: string; period?: string }> }) {
  const user = await requireUser();
  if (!await isAdminUnlockedForUser(user.id)) {
    redirect("/inventory?mapError=Admin+mode+is+required+to+view+inventory+audit+history");
  }
  const params = await searchParams;
  const requestedSku = String(params.sku ?? "2PBP-8").trim().toUpperCase();
  const allProducts = requestedSku === "ALL" || requestedSku === "";
  const reportPeriod = inventoryAuditPeriod(params.period);
  const supabase = getSupabaseAdmin();
  const [products, aliases, routeRows] = await Promise.all([
    fetchQueuePages((from, to) => supabase.from("products").select("id,sku,canonical_name").order("id").range(from, to)),
    fetchQueuePages((from, to) => supabase.from("product_aliases").select("product_id,alias").order("product_id").order("alias").order("id").range(from, to)),
    fetchQueuePages((from, to) => supabase.from("inventory_stock_routes").select("product_id,stock_product_id,operational_key").order("product_id").range(from, to)),
  ]);
  const routes = routeRows as AuditRoute[];
  const matchedProducts = auditProductScope(products as ProductRow[], aliases as AliasRow[], routes, requestedSku);
  const productIds = matchedProducts.map((product) => product.id);
  const attempts = productIds.length ? await fetchQueuePages((from, to) => {
    let query = supabase.from("audit_log").select("id,entity_id,created_at,details")
      .eq("entity_type", "product").eq("action", "STOCK_EDIT_ATTEMPT");
    if (!allProducts) query = query.in("entity_id", productIds);
    if (reportPeriod.start) query = query.gte("created_at", reportPeriod.start).lte("created_at", reportPeriod.end);
    return query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
  }) : [];
  // Read complete lifetime history for the current physical balance. Periods filter the history table only.
  const transactions = productIds.length ? await fetchQueuePages((from, to) => {
    let query = supabase
      .from("inventory_transactions")
      .select("id,product_id,bucket,delta,before_qty,after_qty,reason,source_type,source_event_key,actor_id,created_at");
    if (!allProducts) query = query.in("product_id", productIds);
    query = query.lte("created_at", reportPeriod.end);
    return query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
  }) : [];

  const [fulfillmentData, queue] = await Promise.all([
    productIds.length ? fetchQueuePages((from, to) => {
      let query = supabase.from("fulfillments").select("id,shipping_order_line_id,fulfilled_qty,fulfilled_at,created_at,fulfillment_type,source_event_key,carrier,tracking_number,shipping_order_lines!inner(product_id,shipping_order_id,shipping_orders(order_number,customers(full_name,company_name)))")
        .lte("created_at", reportPeriod.end);
      if (!allProducts) query = query.in("shipping_order_lines.product_id", productIds);
      if (reportPeriod.start) query = query.gte("created_at", reportPeriod.start);
      return query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to);
    }) : Promise.resolve([]),
    // Audit refresh must not redisplay the five-minute cached customer queue.
    loadCanonicalCustomerQueue({ fresh: true }),
  ]);

  const productById = new Map(matchedProducts.map((product) => [product.id, product]));
  const allMovements = (transactions ?? []) as InventoryTransaction[];
  const rows = auditRowsInPeriod(allMovements, reportPeriod.start, reportPeriod.end);
  const currentFloor = auditCurrentFloor(productIds, routes, allMovements);
  const fulfillments = fulfillmentData as unknown as FulfillmentRow[];
  const openOrders = [...new Map(productIds.flatMap(id => queue.queueByProductId.get(id) ?? []).map(row => [row.lineId, row])).values()];
  const openQuantity = openOrders.reduce((sum, row) => sum + row.openQty, 0);
  const checkedAt = new Date().toISOString();
  const onFloorByProduct = new Map<string, number>();
  for (const row of rows) {
    if (row.bucket !== "ON_FLOOR") continue;
    onFloorByProduct.set(row.product_id, (onFloorByProduct.get(row.product_id) ?? 0) + Number(row.delta ?? 0));
  }

  return (
    <main className="inventory-audit-report mx-auto max-w-7xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">Inventory / Ledger Audit</p>
          <h1 className="text-3xl font-bold">Read-only stock trace</h1>
          <p className="mt-2 font-semibold">{allProducts ? "All products" : requestedSku} · {reportPeriod.label} · Pacific time</p>
          <p className="text-sm text-slate-600">{reportPeriod.start ? `${displayDate(reportPeriod.start)} – ` : "Through "}{displayDate(reportPeriod.end)} · {rows.length} stock movements · {attempts.length} edit attempts</p>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">Saved stock movements, fulfillment records, and current open orders. Viewing this report does not change inventory or fulfill orders.</p>
          <AuditRefresh checkedAt={checkedAt} />
        </div>
        <div className="audit-controls flex gap-2"><PrintAuditButton /><Link href="/inventory" className="rounded border px-4 py-2 text-sm font-medium">Back to Inventory</Link></div>
      </div>

      <form className="audit-controls mb-6 flex flex-wrap gap-2" action="/inventory/audit">
        <label className="sr-only" htmlFor="sku">SKU</label>
        <input id="sku" name="sku" defaultValue={requestedSku} className="min-w-0 flex-1 rounded border px-3 py-2" />
        <select name="period" aria-label="History period" defaultValue={reportPeriod.period} className="rounded border px-3 py-2"><option value="all">All history</option><option value="week">This week</option><option value="month">This month</option></select>
        <button className="rounded bg-slate-900 px-4 py-2 font-medium text-white">View history</button>
        <Link href={`/inventory/audit?sku=ALL&period=${reportPeriod.period}`} className="rounded border px-4 py-2">All products</Link>
      </form>

      <section className="mb-6 rounded border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold">Current stock and open orders</h2>
        <p className="mt-2"><strong>Physical On Floor: {currentFloor}</strong> · Open customer quantity: {openQuantity}</p>
        <p className="mt-1 text-sm text-slate-600">Open orders commit stock before shipment. They reduce Available Now but do not deduct physical On Floor until a warehouse shipment is saved. These current totals use all history, regardless of the history-period filter.</p>
        <Link prefetch={false} href={allProducts ? "/inventory" : `/inventory?q=${encodeURIComponent(requestedSku)}`} className="mt-2 inline-block underline">View availability and incoming reservations in Inventory</Link>
        {openOrders.length ? <ul className="mt-3 space-y-1 text-sm">{openOrders.map(row => <li key={row.lineId}><Link prefetch={false} className="underline" href={`/orders/${row.orderId}`}>Invoice {row.invoice}</Link> · {row.openQty} unshipped · Queue {row.position}</li>)}</ul> : <p className="mt-3 text-sm text-slate-500">No open customer obligations for this selection.</p>}
      </section>

      <section className="mb-6 rounded border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold">Recorded fulfillments and shipment edits</h2>
        <p className="mt-1 text-sm text-slate-600">Newest entries first. The period filter uses the recorded date; the physical shipment date is shown separately. External-source completions can have no warehouse stock movement.</p>
        <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="border-b text-xs uppercase text-slate-500"><tr><th className="p-2">Recorded</th><th className="p-2">Physical shipment date</th><th className="p-2">Order / customer</th><th className="p-2">Product</th><th className="p-2">Quantity change</th><th className="p-2">Warehouse stock effect</th><th className="p-2">Tracking / evidence</th></tr></thead>
          <tbody>{fulfillments.map(event => {
            const line = event.shipping_order_lines;
            const order = line.shipping_orders;
            const linked = auditFulfillmentMovements(event.source_event_key, allMovements);
            return <tr key={event.id} className="border-b align-top">
              <td className="p-2 whitespace-nowrap">{displayDate(event.created_at)}</td>
              <td className="p-2 whitespace-nowrap">{displayDate(event.fulfilled_at)}</td>
              <td className="p-2"><Link prefetch={false} className="underline" href={`/orders/${line.shipping_order_id}`}>Invoice {order?.order_number ?? "Unknown"}</Link><div>{order?.customers?.company_name || order?.customers?.full_name}</div></td>
              <td className="p-2">{productById.get(line.product_id)?.canonical_name ?? line.product_id}</td>
              <td className="p-2">{event.fulfilled_qty} · {event.fulfillment_type}</td>
              <td className="p-2">{linked.length ? linked.map(row => <div key={row.id}>{row.delta} ({row.before_qty} → {row.after_qty})</div>) : event.fulfillment_type === "OTHER" ? "External source: no warehouse deduction" : "No linked stock movement recorded"}</td>
              <td className="p-2"><div>{event.carrier} {event.tracking_number}</div><div className="font-mono text-xs text-slate-500">Event: {event.id}</div></td>
            </tr>;
          })}{!fulfillments.length ? <tr><td colSpan={7} className="p-3 text-slate-500">No saved fulfillment events in this period. Open orders above are not completed shipments.</td></tr> : null}</tbody>
        </table></div>
      </section>

      <section className="mb-6 rounded border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold">Stock edit attempts (including no changes)</h2>
        <p className="mt-1 text-sm text-slate-600">These are audit records, not stock movements. They never add to or subtract from inventory.</p>
        {(attempts ?? []).map((attempt) => {
          const details = attempt.details as { actor_name?: string; displayed_qty?: number | null; current_qty?: number; requested_qty?: number; reason?: string; outcome?: string; request_id?: string } | null;
          const posted = details?.request_id && allMovements.some(row => row.source_event_key === `manual-group:${details.request_id}`);
          return <article key={attempt.id} className="audit-attempt mt-3 rounded border p-3 text-sm">
            <p className="font-semibold">{productById.get(attempt.entity_id ?? "")?.sku ?? attempt.entity_id}</p>
            <p>{displayDate(attempt.created_at)} · {details?.actor_name ?? "Admin"} · {posted ? "Count saved — matching stock movement recorded" : details?.outcome ?? "Unknown"}</p>
            <p>Displayed: {details?.displayed_qty ?? "unknown"} · Ledger: {details?.current_qty} · Requested: {details?.requested_qty}</p>
            <p>{details?.reason}</p>
            <p className="font-mono text-xs text-slate-500">Product ID: {attempt.entity_id}</p>
          </article>;
        })}
        {!attempts?.length ? <p className="mt-3 text-sm text-slate-500">No recorded edit attempts. Earlier no-change attempts were not logged and cannot be reconstructed.</p> : null}
      </section>

      <section className="rounded border bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold">{allProducts ? "Stock movement history — all products" : requestedSku}</h2>
        {matchedProducts.length === 0 ? <p className="mt-3 text-sm text-amber-700">No product or alias identity matched this SKU.</p> : (
          <div className="mt-4 space-y-6">
            {matchedProducts.map((product) => {
              const productRows = rows.filter((row) => row.product_id === product.id);
              if (allProducts && productRows.length === 0) return null;
              return (
                <article key={product.id} className="rounded border p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <h3 className="font-semibold">{product.sku ?? "No SKU"}</h3>
                      <p className="text-sm text-slate-600">{product.canonical_name ?? "Unnamed product"}</p>
                      <p className="mt-1 font-mono text-xs text-slate-500">Product ID: {product.id}</p>
                      {routes.find(route => route.product_id === product.id)?.stock_product_id !== product.id ? <p className="text-sm text-slate-600">Historical identity. Its separate ledger is excluded from current stock; the routed stock owner is included in the total above.</p> : null}
                    </div>
                    <p className="rounded bg-slate-100 px-3 py-1 text-sm font-semibold">Net on-floor movement in report: {onFloorByProduct.get(product.id) ?? 0}</p>
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
