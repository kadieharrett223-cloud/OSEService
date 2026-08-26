import crypto from "node:crypto";
import { projectCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue";
import { loadCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-loader";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getQuickbooksFirstPaymentEvidenceReadOnly, type QuickbooksFirstPaymentEvidence } from "./integration";

type QboInvoice = { id: string; qbo_invoice_id: string; invoice_number: string | null; payment_status: string | null };
type ProposalSource = { shippingOrderId: string; qboInvoiceId: string; invoice: string; customer: string; proposedFirstPaymentAt: string; skuImpacts: Array<{ sku: string | null; currentPosition: string; projectedPosition: string }> };

export type QboFirstPaymentBackfillProposal = ProposalSource & { proposalHash: string };
export type QboFirstPaymentBackfillPreview = { generatedAt: string; proposalHash: string; proposals: QboFirstPaymentBackfillProposal[]; summary: { proposedOrders: number; affectedSkus: string[] } };

const isPaid = (status: string | null | undefined) => ["PAID", "PARTIALLY PAID", "PARTIALLY_PAID"].includes(String(status ?? "").trim().toUpperCase());

export function createFirstPaymentProposalHash(proposals: ProposalSource[]) {
  const canonical = proposals
    .map((proposal) => `${proposal.shippingOrderId}\t${proposal.qboInvoiceId}\t${proposal.proposedFirstPaymentAt}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

async function fetchAllQboInvoices() {
  const supabase = getSupabaseAdmin();
  const invoices: QboInvoice[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("qbo_invoices").select("id,qbo_invoice_id,invoice_number,payment_status").range(from, from + 999);
    if (error) throw new Error(error.message);
    invoices.push(...(data ?? []));
    if ((data ?? []).length < 1000) return invoices;
  }
}

function verifiedEvidence(evidence: QuickbooksFirstPaymentEvidence | undefined) {
  return Boolean(evidence?.firstPaymentAt && evidence.paymentTransactionCount === 1);
}

/** Builds a read-only, deterministic proposal. It never updates ERP or QBO data. */
export async function previewVerifiedQboFirstPaymentBackfill(): Promise<QboFirstPaymentBackfillPreview> {
  const [queue, evidenceByInvoiceId, invoices] = await Promise.all([
    loadCanonicalCustomerQueue(),
    getQuickbooksFirstPaymentEvidenceReadOnly(),
    fetchAllQboInvoices(),
  ]);
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const lineById = new Map(queue.canonicalLines.map((line) => [line.id, line]));
  const sourcesByOrderId = new Map<string, ProposalSource>();

  for (const queueRow of queue.queue) {
    const line = lineById.get(queueRow.lineId);
    const parent = line?.shipping_orders;
    const invoice = parent?.source_invoice_id ? invoiceById.get(parent.source_invoice_id) : null;
    const evidence = invoice ? evidenceByInvoiceId.get(invoice.qbo_invoice_id) : undefined;
    if (!parent?.id || !invoice || !isPaid(invoice.payment_status) || parent.first_payment_at || !verifiedEvidence(evidence)) continue;
    const source = sourcesByOrderId.get(parent.id) ?? {
      shippingOrderId: parent.id,
      qboInvoiceId: invoice.qbo_invoice_id,
      invoice: invoice.invoice_number ?? queueRow.invoice,
      customer: parent.qbo_invoices?.customers?.company_name ?? parent.qbo_invoices?.customers?.full_name ?? parent.legacy_customer_name ?? "Customer pending",
      proposedFirstPaymentAt: evidence!.firstPaymentAt,
      skuImpacts: [],
    };
    if (source.qboInvoiceId !== invoice.qbo_invoice_id || source.proposedFirstPaymentAt !== evidence!.firstPaymentAt) continue;
    source.skuImpacts.push({ sku: line?.products?.sku ?? null, currentPosition: queueRow.position, projectedPosition: queueRow.position });
    sourcesByOrderId.set(parent.id, source);
  }

  const sources = [...sourcesByOrderId.values()].sort((left, right) => left.shippingOrderId.localeCompare(right.shippingOrderId));
  const proposedPaymentByOrderId = new Map(sources.map((source) => [source.shippingOrderId, source.proposedFirstPaymentAt]));
  const projectedByLineId = new Map<string, string>();
  const rowsByProduct = new Map<string, typeof queue.queue>();
  for (const queueRow of queue.queue) {
    const parentOrderId = lineById.get(queueRow.lineId)?.shipping_orders?.id;
    const productId = lineById.get(queueRow.lineId)?.product_id;
    if (!productId) continue;
    const rows = rowsByProduct.get(productId) ?? [];
    rows.push({ ...queueRow, firstPaymentAt: parentOrderId ? proposedPaymentByOrderId.get(parentOrderId) ?? queueRow.firstPaymentAt : queueRow.firstPaymentAt });
    rowsByProduct.set(productId, rows);
  }
  for (const rows of rowsByProduct.values()) for (const projected of projectCanonicalCustomerQueue(rows)) projectedByLineId.set(projected.lineId, projected.position);
  for (const source of sources) {
    const matchingQueueRows = queue.queue.filter((queueRow) => lineById.get(queueRow.lineId)?.shipping_orders?.id === source.shippingOrderId);
    source.skuImpacts = matchingQueueRows.map((queueRow) => ({ sku: lineById.get(queueRow.lineId)?.products?.sku ?? null, currentPosition: queueRow.position, projectedPosition: projectedByLineId.get(queueRow.lineId) ?? queueRow.position }));
  }

  const proposalHash = createFirstPaymentProposalHash(sources);
  return {
    generatedAt: new Date().toISOString(),
    proposalHash,
    proposals: sources.map((source) => ({ ...source, proposalHash })),
    summary: { proposedOrders: sources.length, affectedSkus: [...new Set(sources.flatMap((source) => source.skuImpacts.map((impact) => impact.sku).filter((sku): sku is string => Boolean(sku))))].sort() },
  };
}

/**
 * Intentionally unexposed and disabled unless an operator explicitly enables the deployment flag.
 * It reruns the preview and uses NULL predicates to prevent overwriting a concurrently recorded date.
 */
export async function executeVerifiedQboFirstPaymentBackfill(expectedProposalCount: number, expectedProposalHash: string) {
  if (process.env.ENABLE_VERIFIED_QBO_FIRST_PAYMENT_BACKFILL !== "true") throw new Error("Verified first-payment backfill execution is disabled.");
  const preview = await previewVerifiedQboFirstPaymentBackfill();
  if (preview.proposals.length !== expectedProposalCount || preview.proposalHash !== expectedProposalHash) throw new Error("Backfill aborted because the live preview no longer matches the approved proposal.");
  const supabase = getSupabaseAdmin();
  const { data: updatedOrders, error } = await supabase.rpc("apply_verified_qbo_first_payment_backfill", {
    p_proposals: preview.proposals.map((proposal) => ({ order_id: proposal.shippingOrderId, first_payment_at: proposal.proposedFirstPaymentAt })),
  } as never);
  if (error) throw new Error(error.message);
  if (Number(updatedOrders) !== preview.proposals.length) throw new Error("Backfill aborted because the transactional update count did not match the approved proposal.");
  return { updatedOrders: preview.proposals.length, proposalHash: preview.proposalHash };
}