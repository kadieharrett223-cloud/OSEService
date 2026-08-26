import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { recalculateProductQueues } from "@/lib/product-queue";
import { qboSkuCandidates } from "./quickbooks-refresh";
import { classifyQboForwardIntakeLine, isInventoryDemandQuickbooksLine, type QboForwardIntakeDecision } from "./qbo-forward-intake";

const CUTOFF = Date.parse("2026-08-07T00:00:00.000Z");
const PAID_STATUSES = new Set(["Paid", "Partially Paid"]);
const CLOSED_STATUSES = new Set(["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);

type Invoice = { id: string; qbo_invoice_id: string; invoice_number: string | null; customer_id: string | null; payment_status: string | null; invoice_date: string | null; created_at: string; customers?: { company_name: string | null; full_name: string | null } | null };
type InvoiceLine = { id: string; qbo_invoice_id: string; qbo_line_id: string | null; qbo_sku: string | null; source_description: string | null; ordered_qty: number | null; product_id: string | null };
type Order = { id: string; source_invoice_id: string | null; duplicate_of_order_id: string | null; order_number: string | null; customer_id: string | null; legacy_customer_name: string | null; customers?: { company_name: string | null; full_name: string | null } | null };
type OrderLine = { shipping_order_id: string; qbo_invoice_line_id: string | null; product_id: string | null; ordered_qty: number | null; fulfilled_qty: number | null; fulfillment_status: string | null };

export type QboForwardIntakePreviewLine = { qboInvoiceLineId: string; sku: string | null; quantity: number; productId: string | null; decision: QboForwardIntakeDecision };
export type QboForwardIntakePreviewInvoice = { qboInvoiceId: string; invoiceNumber: string | null; customerName: string | null; firstPaymentAt: string; invoiceDate: string | null; decision: QboForwardIntakeDecision; lines: QboForwardIntakePreviewLine[] };

function normalized(value: string | null | undefined) { return String(value ?? "").trim().toUpperCase().replace(/\s+/g, " "); }
function customerName(row: { customers?: { company_name: string | null; full_name: string | null } | null; legacy_customer_name?: string | null }) { return row.customers?.company_name ?? row.customers?.full_name ?? row.legacy_customer_name ?? null; }

async function fetchAllRows<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

function invoiceDecision(decisions: QboForwardIntakeDecision[]) {
  if (decisions.length === 0 || decisions.every((decision) => decision === "NO_INVENTORY_DEMAND")) return "NO_INVENTORY_DEMAND" as const;
  if (decisions.some((decision) => decision === "MANUAL_DUPLICATE_REVIEW")) return "MANUAL_DUPLICATE_REVIEW" as const;
  if (decisions.some((decision) => decision === "MAPPING_REVIEW")) return "MAPPING_REVIEW" as const;
  if (decisions.every((decision) => decision === "ALREADY_REPRESENTED")) return "ALREADY_REPRESENTED" as const;
  if (decisions.every((decision) => decision === "CLOSED")) return "CLOSED" as const;
  return "AUTO_IMPORT" as const;
}

export function selectAutomaticForwardIntakeCandidates(preview: QboForwardIntakePreviewInvoice[]) {
  return preview.filter((invoice) => invoice.decision === "AUTO_IMPORT");
}

/** Read-only candidate analysis. It never writes demand, queues, fulfillments, allocations, or inventory. */
export async function previewQboForwardIntake(firstPaymentByQboInvoiceId: Map<string, string>) {
  const supabase = getSupabaseAdmin();
  const [invoices, invoiceLines, orders, orderLines, products, aliases, resolutions] = await Promise.all([
    fetchAllRows<Invoice>((from, to) => supabase.from("qbo_invoices").select("id,qbo_invoice_id,invoice_number,customer_id,payment_status,invoice_date,created_at,customers(company_name,full_name)").order("id").range(from, to)),
    fetchAllRows<InvoiceLine>((from, to) => supabase.from("qbo_invoice_lines").select("id,qbo_invoice_id,qbo_line_id,qbo_sku,source_description,ordered_qty,product_id").order("id").range(from, to)),
    fetchAllRows<Order>((from, to) => supabase.from("shipping_orders").select("id,source_invoice_id,duplicate_of_order_id,order_number,customer_id,legacy_customer_name,customers(company_name,full_name)").order("id").range(from, to) as unknown as PromiseLike<{ data: Order[] | null; error: { message: string } | null }>),
    fetchAllRows<OrderLine>((from, to) => supabase.from("shipping_order_lines").select("shipping_order_id,qbo_invoice_line_id,product_id,ordered_qty,fulfilled_qty,fulfillment_status").order("id").range(from, to)),
    fetchAllRows<{ id: string; sku: string | null }>((from, to) => supabase.from("products").select("id,sku").order("id").range(from, to)),
    fetchAllRows<{ product_id: string; alias: string | null }>((from, to) => supabase.from("product_aliases").select("product_id,alias").order("id").range(from, to)),
    fetchAllRows<{ qbo_invoice_line_id: string | null; status: string | null }>((from, to) => supabase.from("reviewed_obligation_resolutions").select("qbo_invoice_line_id,status").order("id").range(from, to)),
  ]);
  const productIdBySku = new Map<string, string>();
  for (const product of products) if (product.sku) productIdBySku.set(normalized(product.sku), product.id);
  for (const alias of aliases) if (alias.alias) productIdBySku.set(normalized(alias.alias), alias.product_id);
  const linesByInvoice = new Map<string, InvoiceLine[]>();
  for (const line of invoiceLines) linesByInvoice.set(line.qbo_invoice_id, [...(linesByInvoice.get(line.qbo_invoice_id) ?? []), line]);
  const exactOrderLineIds = new Set(orderLines.flatMap((line) => line.qbo_invoice_line_id ? [line.qbo_invoice_line_id] : []));
  const activeResolutionIds = new Set(resolutions.filter((row) => normalized(row.status) === "ACTIVE" && row.qbo_invoice_line_id).map((row) => String(row.qbo_invoice_line_id)));
  const ordersByInvoice = new Map(orders.filter((order) => order.source_invoice_id && !order.duplicate_of_order_id).map((order) => [order.source_invoice_id!, order]));

  const eligibleInvoices = invoices.filter((invoice) => {
    const firstPaymentAt = firstPaymentByQboInvoiceId.get(invoice.qbo_invoice_id);
    return PAID_STATUSES.has(invoice.payment_status ?? "") && Boolean(firstPaymentAt) && Date.parse(firstPaymentAt!) >= CUTOFF;
  });

  return eligibleInvoices.map((invoice) => {
    const firstPaymentAt = firstPaymentByQboInvoiceId.get(invoice.qbo_invoice_id)!;
    const lines = (linesByInvoice.get(invoice.id) ?? []).map((line) => {
      const productId = line.product_id ?? qboSkuCandidates(line.qbo_sku).map((sku) => productIdBySku.get(normalized(sku))).find(Boolean) ?? null;
      const manualMatch = Boolean(productId) && orders.some((candidate) => candidate.source_invoice_id !== invoice.id && !candidate.duplicate_of_order_id && candidate.order_number && normalized(candidate.order_number) === normalized(invoice.invoice_number) && (candidate.customer_id === invoice.customer_id || normalized(customerName(candidate)) === normalized(customerName(invoice))) && orderLines.some((orderLine) => orderLine.shipping_order_id === candidate.id && orderLine.product_id === productId && Number(orderLine.ordered_qty ?? 0) === Number(line.ordered_qty ?? 0)));
      const terminal = activeResolutionIds.has(line.id) || orderLines.some((orderLine) => orderLine.qbo_invoice_line_id === line.id && (CLOSED_STATUSES.has(normalized(orderLine.fulfillment_status)) || Number(orderLine.fulfilled_qty ?? 0) >= Number(orderLine.ordered_qty ?? 0)));
      return { qboInvoiceLineId: line.id, sku: line.qbo_sku, quantity: Number(line.ordered_qty ?? 0), productId, decision: classifyQboForwardIntakeLine({ isPaymentEligible: true, isInventoryDemandLine: isInventoryDemandQuickbooksLine(line), hasExactExistingLine: exactOrderLineIds.has(line.id), hasTerminalOrReviewedResolution: terminal, hasMappedProduct: Boolean(productId), hasPossibleManualDuplicate: manualMatch, hasConflictingSkuIdentity: false }) };
    });
    const parent = ordersByInvoice.get(invoice.id);
    const decision = parent ? "ALREADY_REPRESENTED" as const : invoiceDecision(lines.map((line) => line.decision));
    return { qboInvoiceId: invoice.id, invoiceNumber: invoice.invoice_number, customerName: customerName(invoice), firstPaymentAt, invoiceDate: invoice.invoice_date, decision, lines };
  }).sort((left, right) => left.firstPaymentAt.localeCompare(right.firstPaymentAt) || String(left.invoiceNumber).localeCompare(String(right.invoiceNumber)));
}

/** Writes demand only for globally enabled, clean QBO candidates. It never creates fulfillment, allocation, or inventory records. */
export async function executeQboForwardIntake(firstPaymentByQboInvoiceId: Map<string, string>) {
  const supabase = getSupabaseAdmin();
  const preview = await previewQboForwardIntake(firstPaymentByQboInvoiceId);
  const candidates = selectAutomaticForwardIntakeCandidates(preview);
  const reviewCandidates = preview.filter((invoice) => invoice.decision === "MAPPING_REVIEW" || invoice.decision === "MANUAL_DUPLICATE_REVIEW");
  const productIds = new Set<string>();
  let importedLines = 0;

  for (const candidate of reviewCandidates) {
    for (const previewLine of candidate.lines.filter((line) => line.decision === "MAPPING_REVIEW" || line.decision === "MANUAL_DUPLICATE_REVIEW")) {
      const { data: sourceLine, error: sourceLineError } = await supabase
        .from("qbo_invoice_lines")
        .select("id,qbo_sku,source_description,ordered_qty")
        .eq("id", previewLine.qboInvoiceLineId)
        .single();
      if (sourceLineError || !sourceLine) throw new Error(sourceLineError?.message ?? "Forward-intake review line disappeared during execution.");
      if (previewLine.decision === "MAPPING_REVIEW") {
        const { error } = await (supabase.from("manual_product_mapping_queue") as any).upsert({
          source_sku: sourceLine.qbo_sku ?? "UNMAPPED_QBO_LINE",
          source_description: sourceLine.source_description,
          customer_name: candidate.customerName,
          invoice_number: candidate.invoiceNumber,
          quantity: sourceLine.ordered_qty,
          source_system: "QBO_FORWARD_INTAKE",
          source_record_id: sourceLine.id,
          first_payment_at: candidate.firstPaymentAt,
        }, { onConflict: "source_system,source_record_id" });
        if (error) throw new Error(error.message);
      } else {
        const { error } = await (supabase.from("qbo_backlog_import_reviews") as any).upsert({
          qbo_invoice_line_id: sourceLine.id,
          review_type: "MANUAL_DUPLICATE",
          first_payment_at: candidate.firstPaymentAt,
          invoice_number: candidate.invoiceNumber,
          customer_name: candidate.customerName,
          qbo_sku: sourceLine.qbo_sku,
          source_description: sourceLine.source_description,
          quantity: sourceLine.ordered_qty,
        }, { onConflict: "qbo_invoice_line_id" });
        if (error) throw new Error(error.message);
      }
    }
  }

  for (const candidate of candidates) {
    const { data: rawInvoice, error: invoiceError } = await supabase
      .from("qbo_invoices")
      .select("id,qbo_invoice_id,invoice_number,customer_id,customers(company_name,full_name)")
      .eq("id", candidate.qboInvoiceId)
      .single();
    const invoice = rawInvoice as unknown as { id: string; qbo_invoice_id: string; invoice_number: string | null; customer_id: string | null; customers: { company_name: string | null; full_name: string | null } | null } | null;
    if (invoiceError || !invoice) throw new Error(invoiceError?.message ?? "Forward-intake invoice disappeared during execution.");

    const { data: existingOrder, error: orderLookupError } = await supabase
      .from("shipping_orders")
      .select("id,duplicate_of_order_id")
      .eq("source_invoice_id", invoice.id)
      .is("duplicate_of_order_id", null)
      .maybeSingle();
    if (orderLookupError) throw new Error(orderLookupError.message);
    if (existingOrder) continue;

    const customer = invoice.customers as unknown as { company_name: string | null; full_name: string | null } | null;
    const { data: order, error: orderError } = await supabase.from("shipping_orders").insert({
      customer_id: invoice.customer_id,
      source_invoice_id: invoice.id,
      order_number: invoice.invoice_number,
      source_type: "QBO_INVOICE",
      review_status: "APPROVED",
      legacy_customer_name: customer?.company_name ?? customer?.full_name ?? null,
      first_payment_at: candidate.firstPaymentAt,
    } as never).select("id").single();
    if (orderError || !order) {
      if (orderError?.code === "23505") continue;
      throw new Error(orderError?.message ?? "Could not create forward-intake order.");
    }

    for (const previewLine of candidate.lines.filter((line): line is typeof line & { productId: string } => line.decision === "AUTO_IMPORT" && Boolean(line.productId))) {
      const { data: sourceLine, error: sourceLineError } = await supabase
        .from("qbo_invoice_lines")
        .select("id,qbo_line_id,qbo_sku,ordered_qty")
        .eq("id", previewLine.qboInvoiceLineId)
        .single();
      if (sourceLineError || !sourceLine) throw new Error(sourceLineError?.message ?? "Forward-intake line disappeared during execution.");
      const { error: lineError } = await supabase.from("shipping_order_lines").insert({
        shipping_order_id: order.id,
        qbo_invoice_line_id: sourceLine.id,
        product_id: previewLine.productId,
        ordered_qty: sourceLine.ordered_qty,
        approved_qty: sourceLine.ordered_qty,
        fulfilled_qty: 0,
        cancelled_qty: 0,
        approval_status: "APPROVED",
        warehouse_status: "ON_FLOOR",
        allocation_status: "UNALLOCATED",
        fulfillment_status: "PENDING",
        priority: "NORMAL",
        source_event_key: `QBO_INVOICE_LINE:${invoice.qbo_invoice_id}:${sourceLine.qbo_line_id}`,
        legacy_item_code: sourceLine.qbo_sku,
      });
      if (lineError && lineError.code !== "23505") throw new Error(lineError.message);
      if (!lineError) {
        importedLines += 1;
        productIds.add(previewLine.productId);
      }
    }
  }

  await recalculateProductQueues([...productIds]);
  return { importedLines, affectedProductIds: [...productIds] };
}

/** Sync integration point. Missing or disabled state is deliberately a no-op for safe deployment. */
export async function runEnabledQboForwardIntake(firstPaymentByQboInvoiceId: Map<string, string>) {
  const supabase = getSupabaseAdmin();
  const { data: rawState, error } = await (supabase.from("qbo_forward_intake_state") as any).select("is_enabled").eq("id", true).maybeSingle();
  const data = rawState as { is_enabled?: boolean } | null;
  if (error || !data?.is_enabled) return { enabled: false, importedLines: 0, affectedProductIds: [] as string[] };
  return { enabled: true, ...(await executeQboForwardIntake(firstPaymentByQboInvoiceId)) };
}