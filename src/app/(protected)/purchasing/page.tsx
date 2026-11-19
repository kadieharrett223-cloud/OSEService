import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type PurchaseOrder = {
  source_po_id: string;
  po_number: string;
  supplier: string;
  order_date: string | null;
  checked_at: string;
  verification_note: string | null;
  evidence_url: string | null;
};

type PurchaseOrderLine = {
  source_line_id: string;
  source_po_id: string;
  line_number: number;
  sku: string | null;
  description: string;
  quantity: number;
  unit_cost: number;
};

const money = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);

export default async function PurchasingPage() {
  await requireUser();
  const db = getSupabaseAdmin();
  const [{ data: orders, error: ordersError }, { data: lines, error: linesError }] = await Promise.all([
    db.from("purchasing_po_snapshots")
      .select("source_po_id,po_number,supplier,order_date,checked_at,verification_note,evidence_url")
      .order("po_number", { ascending: false }),
    db.from("purchasing_po_line_snapshots")
      .select("source_line_id,source_po_id,line_number,sku,description,quantity,unit_cost")
      .order("line_number"),
  ]);

  if (ordersError || linesError) {
    return <div className="rounded-xl border border-red-200 bg-white p-6 text-red-700">PO details are unavailable right now.</div>;
  }

  const purchaseOrders = (orders ?? []) as PurchaseOrder[];
  const purchaseLines = (lines ?? []) as PurchaseOrderLine[];
  const { data: containers } = purchaseOrders.length
    ? await db.from("containers").select("id,container_number").in("container_number", purchaseOrders.map((po) => po.po_number))
    : { data: [] };
  const containerByNumber = new Map((containers ?? []).map((row: { id: string; container_number: string }) => [row.container_number, row.id]));

  return (
    <div className="space-y-6">
      <header className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
        <h1 className="text-3xl font-semibold text-[#111827]">PO Details</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">Supplier and owner PO details for receiving and shipping. Purchasing decisions and payments stay with the owners.</p>
      </header>

      {purchaseOrders.length === 0 ? (
        <div className="rounded-2xl border border-[#e5e7eb] bg-white p-6 text-sm text-[#5a5a5a]">No purchase orders have been checked for this view yet.</div>
      ) : purchaseOrders.map((po) => {
        const poLines = purchaseLines.filter((line) => line.source_po_id === po.source_po_id);
        const containerId = containerByNumber.get(po.po_number);
        return (
          <section key={po.source_po_id} className="rounded-2xl border border-[#e5e7eb] bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-[#111827]">PO {po.po_number} · {po.supplier}</h2>
                <p className="mt-1 text-sm text-[#6b7280]">Ordered {po.order_date ?? "date pending"} · Checked {new Date(po.checked_at).toLocaleDateString("en-US")}</p>
              </div>
              {containerId ? <Link href={`/containers/${containerId}`} className="btn-secondary">Container details</Link> : null}
            </div>
            {po.verification_note ? <p className="mt-4 rounded-lg bg-[#f8fafc] p-3 text-sm text-[#334155]">{po.verification_note}</p> : null}
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-[#e5e7eb] text-[#475569]"><tr>
                  <th className="px-3 py-2">Item</th><th className="px-3 py-2">Description and packing</th>
                  <th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Unit cost</th>
                </tr></thead>
                <tbody className="divide-y divide-[#e5e7eb]">
                  {poLines.map((line) => <tr key={line.source_line_id} className="align-top">
                    <td className="px-3 py-3 font-medium text-[#111827]">{line.sku ?? `Line ${line.line_number}`}</td>
                    <td className="max-w-2xl px-3 py-3 text-[#374151]">{line.description}</td>
                    <td className="px-3 py-3 text-right">{Number(line.quantity)}</td>
                    <td className="px-3 py-3 text-right">{money(Number(line.unit_cost))}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            {po.evidence_url ? <a href={po.evidence_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-sm font-medium text-[#9f0712] underline">Supplier email</a> : null}
          </section>
        );
      })}
    </div>
  );
}
