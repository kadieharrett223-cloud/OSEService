import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { loadCanonicalCustomerQueue, type CanonicalQueueLine } from "@/lib/demand/canonical-customer-queue-loader";
import { demandLineIdentity, isOpenCustomerQueueLine, isOpenDemandLine } from "@/lib/demand/product-demand";
import { persistAuditedQueuePositionsAction } from "./actions";

type AuditRow = {
  line: CanonicalQueueLine;
  reason: string;
  projectedPosition: string | null;
};

function customerName(line: CanonicalQueueLine) {
  return line.shipping_orders?.qbo_invoices?.customers?.company_name
    ?? line.shipping_orders?.qbo_invoices?.customers?.full_name
    ?? line.shipping_orders?.legacy_customer_name
    ?? "Customer pending";
}

function invoiceNumber(line: CanonicalQueueLine) {
  return line.shipping_orders?.qbo_invoices?.invoice_number
    ?? line.shipping_orders?.order_number
    ?? "—";
}

function sku(line: CanonicalQueueLine) {
  return line.products?.sku
    ?? line.qbo_invoice_lines?.qbo_sku
    ?? line.legacy_item_code
    ?? "—";
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (!rows.length) return <p className="mt-3 text-sm text-[#0f6f35]">None found.</p>;

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead>
          <tr className="border-b border-[#ececec] text-[#5a5a5a]">
            <th className="px-2 py-2">Customer</th>
            <th className="px-2 py-2">Invoice</th>
            <th className="px-2 py-2">Product / QBO item</th>
            <th className="px-2 py-2">Reason</th>
            <th className="px-2 py-2">Projected position</th>
            <th className="px-2 py-2">Order</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ line, reason, projectedPosition }) => (
            <tr key={`${line.id}-${reason}`} className="border-b border-[#f1f5f9]">
              <td className="px-2 py-2">{customerName(line)}</td>
              <td className="px-2 py-2">{invoiceNumber(line)}</td>
              <td className="px-2 py-2">{sku(line)}</td>
              <td className="px-2 py-2">{reason}</td>
              <td className="px-2 py-2">{projectedPosition ?? "—"}</td>
              <td className="px-2 py-2">
                {line.shipping_orders?.id ? <Link className="text-[#0a58ca] underline" href={`/orders/${line.shipping_orders.id}`}>Open order</Link> : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function QueueIntegrityPage({ searchParams }: { searchParams: Promise<{ run?: string; message?: string }> }) {
  await requireUser();
  if ((await searchParams).run !== "1") {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl">Customer List Integrity Audit</h1>
        <p className="text-sm text-[#5a5a5a]">Read-only. Checks every active canonical obligation for a real product identity and the Customer List position used by operations. It never writes products, stock, shipments, allocations, orders, or queue positions.</p>
        <div className="flex gap-2"><Link href="/settings/queue-integrity?run=1" className="btn-primary">Run audit</Link><Link href="/settings" className="btn-secondary">Back</Link></div>
      </div>
    );
  }

  const { queue, canonicalLines, qboInvoiceLines, queueByLineId, queueByLogicalDemandKey } = await loadCanonicalCustomerQueue();
  const { message } = await searchParams;
  const activeMappedLines = canonicalLines.filter(isOpenCustomerQueueLine);
  const activeUnmappedLines = canonicalLines.filter((line) => (
    !line.product_id
    && isOpenDemandLine(line)
    && line.shipping_orders?.source_type === "QBO_INVOICE"
    && Boolean(line.qbo_invoice_line_id)
  ));
  const qboProductIdByLineId = new Map(qboInvoiceLines.map((line) => [line.id, line.product_id]));

  const noProjectedPosition: AuditRow[] = [];
  const noStoredPosition: AuditRow[] = [];
  const productDisagreements: AuditRow[] = [];

  for (const line of activeMappedLines) {
    const projected = queueByLineId.get(line.id) ?? queueByLogicalDemandKey.get(demandLineIdentity(line));
    if (!projected?.position) {
      noProjectedPosition.push({ line, reason: "No current Customer List row", projectedPosition: null });
      continue;
    }
    if (line.queue_position_start == null || Number(line.queue_position_start) < 1) {
      noStoredPosition.push({ line, reason: "Position is computed live but not persisted on this source line", projectedPosition: projected.position });
    }
    const qboProductId = line.qbo_invoice_line_id ? qboProductIdByLineId.get(line.qbo_invoice_line_id) : null;
    if (qboProductId && qboProductId !== line.product_id) {
      productDisagreements.push({ line, reason: "Order-line product differs from the linked QBO line", projectedPosition: projected.position });
    }
  }

  const unmappedRows = activeUnmappedLines.map((line) => ({ line, reason: "Active QBO obligation has no product identity", projectedPosition: null }));
  const positionProductIds = [...new Set(noStoredPosition.map(({ line }) => line.product_id).filter((productId): productId is string => Boolean(productId)))];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl">Customer List Integrity Audit</h1>
        <p className="mt-1 text-sm text-[#5a5a5a]">Read-only result from the same canonical queue used by Inventory and Orders. No business data was changed.</p>
      </div>
      {message ? <p className="rounded-md border border-[#bfdcc5] bg-[#f3fff6] p-3 text-sm text-[#0f5b28]">{message}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card p-3"><p className="text-sm text-[#5a5a5a]">Active Customer List obligations</p><p className="text-2xl font-semibold">{queue.length}</p></div>
        <div className="card p-3"><p className="text-sm text-[#5a5a5a]">Missing product identity</p><p className="text-2xl font-semibold">{unmappedRows.length}</p></div>
        <div className="card p-3"><p className="text-sm text-[#5a5a5a]">Missing displayed position</p><p className="text-2xl font-semibold">{noProjectedPosition.length}</p></div>
        <div className="card p-3"><p className="text-sm text-[#5a5a5a]">Product identity disagreements</p><p className="text-2xl font-semibold">{productDisagreements.length}</p></div>
      </div>
      <section className="card p-4"><h2 className="text-xl">Active QBO obligations without a product identity</h2><p className="mt-1 text-sm text-[#5a5a5a]">These are the only active QBO lines that cannot enter any Customer List because they have no product identity.</p><AuditTable rows={unmappedRows} /></section>
      <section className="card p-4"><h2 className="text-xl">Mapped obligations missing from the displayed Customer List</h2><p className="mt-1 text-sm text-[#5a5a5a]">Every listed line is active, mapped, and eligible, but has no projected queue row.</p><AuditTable rows={noProjectedPosition} /></section>
      <section className="card p-4"><h2 className="text-xl">Product identity disagreements</h2><p className="mt-1 text-sm text-[#5a5a5a]">The order line and its linked QBO invoice line point to different products. This is diagnostic only; it does not remap either record.</p><AuditTable rows={productDisagreements} /></section>
      <section className="card p-4"><h2 className="text-xl">Source lines with a live-computed but unpersisted position</h2><p className="mt-1 text-sm text-[#5a5a5a]">These customers do appear in the live list. The action below persists exactly the current projected positions; it changes no inventory, mapping, allocations, fulfillment, shipments, or orders.</p>{positionProductIds.length ? <form action={persistAuditedQueuePositionsAction} className="mt-3"><input type="hidden" name="product_ids" value={positionProductIds.join(",")} /><button className="btn-primary" type="submit">Save current positions for these lines</button></form> : null}<AuditTable rows={noStoredPosition} /></section>
      <Link href="/settings" className="btn-secondary">Back to Settings</Link>
    </div>
  );
}
