import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { classifyQboForwardIntakeLine, isInventoryDemandQuickbooksLine, type QboForwardIntakeDecision } from "./qbo-forward-intake";
import { qboSkuCandidates } from "./quickbooks-refresh";

export type HistoricalQboIntakeReviewRow = {
  invoice: string | null; customer: string | null; qboInvoiceLineId: string; sku: string | null; quantity: number;
  paymentStatus: string | null; representation: string; mappingStatus: string; terminalStatus: string;
  decision: QboForwardIntakeDecision | "PENDING_ACTIVATION"; action: "MAP_PRODUCT" | "REVIEW";
};

const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();
const PAID = new Set(["PAID", "PARTIALLY PAID"]);
const CLOSED = new Set(["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);

async function all<T>(fetch: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) { const { data, error } = await fetch(from, from + 999); if (error) throw new Error(error.message); rows.push(...(data ?? [])); if ((data ?? []).length < 1000) return rows; }
}

/** Read-only review population for historical paid QBO lines; it never activates demand. */
export async function loadHistoricalQboIntakeReview(): Promise<HistoricalQboIntakeReviewRow[]> {
  const db = getSupabaseAdmin();
  const [invoices, qboLines, orders, lines, products, aliases, resolutions] = await Promise.all([
    all((from, to) => db.from("qbo_invoices").select("id,invoice_number,payment_status,customers(company_name,full_name)").range(from, to)),
    all((from, to) => db.from("qbo_invoice_lines").select("id,qbo_invoice_id,qbo_sku,source_description,ordered_qty,product_id").range(from, to)),
    all((from, to) => db.from("shipping_orders").select("id,source_invoice_id,duplicate_of_order_id,review_status,cancellation_status").range(from, to) as unknown as PromiseLike<{ data: Array<{ id: string; source_invoice_id: string | null; duplicate_of_order_id: string | null; review_status: string | null; cancellation_status: string | null }> | null; error: { message: string } | null }>),
    all((from, to) => db.from("shipping_order_lines").select("shipping_order_id,qbo_invoice_line_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status").range(from, to)),
    all((from, to) => db.from("products").select("id,sku").range(from, to)),
    all((from, to) => db.from("product_aliases").select("product_id,alias").range(from, to)),
    all((from, to) => db.from("reviewed_obligation_resolutions").select("qbo_invoice_line_id,status").range(from, to)),
  ]);
  const productBySku = new Map<string, string>();
  for (const row of [...products as Array<{ id: string; sku: string | null }>, ...aliases as Array<{ product_id: string; alias: string | null }>]) {
    const sku = "sku" in row ? row.sku : row.alias; const id = "id" in row ? row.id : row.product_id;
    if (sku) productBySku.set(upper(sku), id);
  }
  const invoiceById = new Map((invoices as Array<{ id: string; invoice_number: string | null; payment_status: string | null; customers?: { company_name: string | null; full_name: string | null } | null }>).map((invoice) => [invoice.id, invoice]));
  type Representation = { shipping_order_id: string; qbo_invoice_line_id: string | null; approved_qty: number | null; fulfilled_qty: number | null; approval_status: string | null; fulfillment_status: string | null };
  const linesByQboId = new Map<string, Representation[]>();
  for (const line of lines as Representation[]) if (line.qbo_invoice_line_id) linesByQboId.set(line.qbo_invoice_line_id, [...(linesByQboId.get(line.qbo_invoice_line_id) ?? []), line]);
  const ordersById = new Map((orders as Array<{ id: string; duplicate_of_order_id: string | null; cancellation_status: string | null }>).map((order) => [order.id, order]));
  const terminal = new Set((resolutions as Array<{ qbo_invoice_line_id: string | null; status: string | null }>).filter((row) => upper(row.status) === "ACTIVE" && row.qbo_invoice_line_id).map((row) => row.qbo_invoice_line_id!));
  return (qboLines as Array<{ id: string; qbo_invoice_id: string; qbo_sku: string | null; source_description: string | null; ordered_qty: number | null; product_id: string | null }>).flatMap((source) => {
    const invoice = invoiceById.get(source.qbo_invoice_id); if (!invoice || !PAID.has(upper(invoice.payment_status)) || !isInventoryDemandQuickbooksLine(source)) return [];
    const productId = source.product_id ?? qboSkuCandidates(source.qbo_sku).map((sku) => productBySku.get(upper(sku))).find(Boolean) ?? null;
    const representations = linesByQboId.get(source.id) ?? [];
    const activeRepresentations = representations.filter((line) => { const parent = ordersById.get(line.shipping_order_id) as { duplicate_of_order_id?: string | null; cancellation_status?: string | null } | undefined; return !parent?.duplicate_of_order_id && upper(parent?.cancellation_status) !== "CANCELLED"; });
    const open = activeRepresentations.some((line) => Number(line.approved_qty ?? 0) > Number(line.fulfilled_qty ?? 0) && ["APPROVED", "PARTIAL"].includes(upper(line.approval_status)) && !CLOSED.has(upper(line.fulfillment_status)));
    const isTerminal = terminal.has(source.id) || activeRepresentations.some((line) => CLOSED.has(upper(line.fulfillment_status)) || Number(line.fulfilled_qty ?? 0) >= Number(source.ordered_qty ?? 0));
    if (open || isTerminal) return [];
    const decision = classifyQboForwardIntakeLine({ isPaymentEligible: true, isInventoryDemandLine: true, hasExactExistingLine: false, hasTerminalOrReviewedResolution: isTerminal, hasMappedProduct: Boolean(productId), hasPossibleManualDuplicate: false, hasConflictingSkuIdentity: false });
    const pending = activeRepresentations.length > 0;
    return [{ invoice: invoice.invoice_number, customer: invoice.customers?.company_name ?? invoice.customers?.full_name ?? null, qboInvoiceLineId: source.id, sku: source.qbo_sku, quantity: Number(source.ordered_qty ?? 0), paymentStatus: invoice.payment_status, representation: pending ? "PENDING_REVIEW (not approved)" : "No ERP line", mappingStatus: productId ? "Mapped" : "Mapping required", terminalStatus: isTerminal ? "Terminal" : "Open", decision: (productId && pending ? "PENDING_ACTIVATION" : decision) as HistoricalQboIntakeReviewRow["decision"], action: (productId ? "REVIEW" : "MAP_PRODUCT") as HistoricalQboIntakeReviewRow["action"] }];
  }).sort((left, right) => String(left.invoice).localeCompare(String(right.invoice)) || left.qboInvoiceLineId.localeCompare(right.qboInvoiceLineId));
}