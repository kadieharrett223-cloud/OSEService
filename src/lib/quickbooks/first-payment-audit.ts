import { projectCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue";
import { loadCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-loader";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { getQuickbooksFirstPaymentEvidenceReadOnly } from "./integration";

export type QboFirstPaymentAuditRow = {
  customer: string;
  invoice: string;
  sku: string | null;
  qboStatus: string | null;
  currentFirstPaymentAt: string | null;
  verifiedFirstPaymentAt: string | null;
  currentQueuePosition: string;
  projectedQueuePosition: string;
  evidenceStatus: "VERIFIED" | "MULTIPLE_PAYMENTS" | "UNVERIFIED";
  qboPaymentTransactionCount: number;
};

export type QboFirstPaymentAudit = {
  generatedAt: string;
  rows: QboFirstPaymentAuditRow[];
  summary: {
    activeCanonicalRows: number;
    affectedRows: number;
    affectedInvoices: number;
    verifiedPaymentDates: number;
    unverified: number;
    multiplePaymentTransactions: number;
    affectedSkus: string[];
  };
};

const isPaid = (status: string | null | undefined) => ["PAID", "PARTIALLY PAID", "PARTIALLY_PAID"].includes(String(status ?? "").trim().toUpperCase());

async function fetchAllQboInvoices() {
  const supabase = getSupabaseAdmin();
  const invoices: Array<{ id: string; qbo_invoice_id: string; invoice_number: string | null; payment_status: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("qbo_invoices")
      .select("id,qbo_invoice_id,invoice_number,payment_status")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    invoices.push(...(data ?? []));
    if ((data ?? []).length < 1000) return invoices;
  }
}

/** Builds a display/export audit only; it performs no ERP or QBO writes. */
export async function runQboFirstPaymentAudit(): Promise<QboFirstPaymentAudit> {
  const [queue, qboPaymentEvidence, invoices] = await Promise.all([
    loadCanonicalCustomerQueue(),
    getQuickbooksFirstPaymentEvidenceReadOnly(),
    fetchAllQboInvoices(),
  ]);
  const invoiceById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const lineById = new Map(queue.canonicalLines.map((line) => [line.id, line]));
  const productIdByLineId = new Map(queue.canonicalLines.map((line) => [line.id, line.product_id]));
  const projectedByLineId = new Map<string, string>();
  const rowsByProduct = new Map<string, typeof queue.queue>();

  for (const queueRow of queue.queue) {
    const line = lineById.get(queueRow.lineId);
    const invoice = line?.shipping_orders?.source_invoice_id ? invoiceById.get(line.shipping_orders.source_invoice_id) : null;
    const evidence = invoice ? qboPaymentEvidence.get(invoice.qbo_invoice_id) : null;
    const productId = productIdByLineId.get(queueRow.lineId);
    if (!productId) continue;
    const rows = rowsByProduct.get(productId) ?? [];
    rows.push({
      ...queueRow,
      firstPaymentAt: queueRow.firstPaymentAt ?? evidence?.firstPaymentAt ?? null,
    });
    rowsByProduct.set(productId, rows);
  }
  for (const productRows of rowsByProduct.values()) {
    for (const projected of projectCanonicalCustomerQueue(productRows)) projectedByLineId.set(projected.lineId, projected.position);
  }

  const rows = queue.queue.flatMap((queueRow): QboFirstPaymentAuditRow[] => {
    const line = lineById.get(queueRow.lineId);
    const invoice = line?.shipping_orders?.source_invoice_id ? invoiceById.get(line.shipping_orders.source_invoice_id) : null;
    if (!line || !invoice || !isPaid(invoice.payment_status) || queueRow.firstPaymentAt) return [];
    const evidence = qboPaymentEvidence.get(invoice.qbo_invoice_id) ?? null;
    return [{
      customer: line.shipping_orders?.qbo_invoices?.customers?.company_name
        ?? line.shipping_orders?.qbo_invoices?.customers?.full_name
        ?? line.shipping_orders?.legacy_customer_name
        ?? "Customer pending",
      invoice: invoice.invoice_number ?? queueRow.invoice,
      sku: line.products?.sku ?? null,
      qboStatus: invoice.payment_status,
      currentFirstPaymentAt: queueRow.firstPaymentAt,
      verifiedFirstPaymentAt: evidence?.firstPaymentAt ?? null,
      currentQueuePosition: queueRow.position,
      projectedQueuePosition: projectedByLineId.get(queueRow.lineId) ?? queueRow.position,
      evidenceStatus: !evidence ? "UNVERIFIED" : evidence.paymentTransactionCount > 1 ? "MULTIPLE_PAYMENTS" : "VERIFIED",
      qboPaymentTransactionCount: evidence?.paymentTransactionCount ?? 0,
    }];
  }).sort((left, right) => left.sku?.localeCompare(right.sku ?? "") || left.invoice.localeCompare(right.invoice));

  return {
    generatedAt: new Date().toISOString(),
    rows,
    summary: {
      activeCanonicalRows: queue.queue.length,
      affectedRows: rows.length,
      affectedInvoices: new Set(rows.map((row) => `${row.invoice}|${row.qboStatus}`)).size,
      verifiedPaymentDates: rows.filter((row) => row.evidenceStatus !== "UNVERIFIED").length,
      unverified: rows.filter((row) => row.evidenceStatus === "UNVERIFIED").length,
      multiplePaymentTransactions: rows.filter((row) => row.evidenceStatus === "MULTIPLE_PAYMENTS").length,
      affectedSkus: [...new Set(rows.map((row) => row.sku).filter((sku): sku is string => Boolean(sku)))].sort(),
    },
  };
}