import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { recalculateProductQueues } from "@/lib/product-queue";
import { buildSafeQboProductIdByAlias, liveQuickBooksLineQuantities, qboSkuCandidates } from "./quickbooks-refresh";
import { classifyQboForwardIntakeLine, isInventoryDemandQuickbooksLine, type QboForwardIntakeDecision } from "./qbo-forward-intake";
import { isUnsafeGlobalProductAlias } from "@/lib/products/canonical-sku";
import { isWithinAutomaticQboIntake, qboIntakePriorityDate } from "./qbo-intake-policy";

const PAID_STATUSES = new Set(["Paid", "Partially Paid"]);
const CLOSED_STATUSES = new Set(["FULFILLED", "SHIPPED", "ARCHIVED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);

type Invoice = { id: string; qbo_invoice_id: string; invoice_number: string | null; customer_id: string | null; payment_status: string | null; invoice_date: string | null; created_at: string; raw_payload?: { PrivateNote?: string | null; Line?: unknown[] } | null; customers?: { company_name: string | null; full_name: string | null } | null };
type InvoiceLine = { id: string; qbo_invoice_id: string; qbo_line_id: string | null; qbo_sku: string | null; source_description: string | null; ordered_qty: number | null; product_id: string | null };
type Order = { id: string; source_invoice_id: string | null; duplicate_of_order_id: string | null; cancellation_status?: string | null; review_status?: string | null; order_number: string | null; customer_id: string | null; legacy_customer_name: string | null; customers?: { company_name: string | null; full_name: string | null } | null };
type OrderLine = { shipping_order_id: string; qbo_invoice_line_id: string | null; product_id: string | null; ordered_qty: number | null; fulfilled_qty: number | null; fulfillment_status: string | null };

export type QboForwardIntakePreviewLine = { qboInvoiceLineId: string; sku: string | null; quantity: number; productId: string | null; decision: QboForwardIntakeDecision };
export type QboForwardIntakePreviewInvoice = { qboInvoiceId: string; invoiceNumber: string | null; customerName: string | null; firstPaymentAt: string | null; invoiceDate: string | null; priorityDate?: string | null; priorityDateSource?: "FIRST_PAYMENT" | "INVOICE_DATE"; decision: QboForwardIntakeDecision; lines: QboForwardIntakePreviewLine[] };

function normalized(value: string | null | undefined) { return String(value ?? "").trim().toUpperCase().replace(/\s+/g, " "); }
function customerName(row: { customers?: { company_name: string | null; full_name: string | null } | null; legacy_customer_name?: string | null }) { return row.customers?.company_name ?? row.customers?.full_name ?? row.legacy_customer_name ?? null; }
function sameKnownCustomer(left: Order, right: Invoice) {
  if (left.customer_id && right.customer_id) return left.customer_id === right.customer_id;
  const name = normalized(customerName(left));
  return Boolean(name) && name === normalized(customerName(right));
}

async function fetchAllRows<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await fetchPage(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) return rows;
  }
}

export function summarizeQboInvoiceIntake(decisions: QboForwardIntakeDecision[]) {
  const inventoryDecisions = decisions.filter((decision) => decision !== "NO_INVENTORY_DEMAND");
  if (inventoryDecisions.length === 0) return "NO_INVENTORY_DEMAND" as const;
  if (inventoryDecisions.some((decision) => decision === "MANUAL_DUPLICATE_REVIEW")) return "MANUAL_DUPLICATE_REVIEW" as const;
  if (inventoryDecisions.some((decision) => decision === "MAPPING_REVIEW")) return "MAPPING_REVIEW" as const;
  if (inventoryDecisions.some((decision) => decision === "AUTO_IMPORT")) return "AUTO_IMPORT" as const;
  if (inventoryDecisions.every((decision) => decision === "ALREADY_REPRESENTED")) return "ALREADY_REPRESENTED" as const;
  return "CLOSED" as const;
}

export function selectAutomaticForwardIntakeCandidates(preview: QboForwardIntakePreviewInvoice[]) {
  // A discount, delivery, or newly introduced unmapped line must not strand
  // the other clean physical items on the same paid invoice. Import those
  // safe, mapped obligations; the unmatched line remains visible for review.
  // Identity conflicts stay out of automatic creation entirely.
  return preview.filter((invoice) => invoice.decision === "AUTO_IMPORT"
    || (invoice.decision !== "MANUAL_DUPLICATE_REVIEW"
      && invoice.lines.some((line) => line.decision === "AUTO_IMPORT")));
}

/** The only forward-intake decisions that require a human review. */
export function selectForwardIntakeReviewCandidates(preview: QboForwardIntakePreviewInvoice[]) {
  return preview.filter((invoice) => invoice.decision === "MAPPING_REVIEW" || invoice.decision === "MANUAL_DUPLICATE_REVIEW");
}

export function selectObsoleteForwardIntakeReviews(preview: QboForwardIntakePreviewInvoice[]) {
  return preview.flatMap((invoice) => invoice.lines
    .filter((line) => ["CLOSED", "ALREADY_REPRESENTED", "NO_INVENTORY_DEMAND"].includes(line.decision))
    .map((line) => ({ qboInvoiceLineId: line.qboInvoiceLineId, reason: `Current exact-source check: ${line.decision}. No stock or fulfillment changed.` })));
}

async function resolveObsoleteForwardIntakeReviews(preview: QboForwardIntakePreviewInvoice[]) {
  const supabase = getSupabaseAdmin();
  const open = await fetchAllRows<{ qbo_invoice_line_id: string }>((from, to) => (supabase.from("qbo_backlog_import_reviews") as any)
    .select("qbo_invoice_line_id").eq("status", "OPEN").order("id").range(from, to));
  const openIds = new Set(open.map((row) => row.qbo_invoice_line_id));
  const idsByReason = new Map<string, string[]>();
  for (const review of selectObsoleteForwardIntakeReviews(preview).filter((row) => openIds.has(row.qboInvoiceLineId))) {
    idsByReason.set(review.reason, [...(idsByReason.get(review.reason) ?? []), review.qboInvoiceLineId]);
  }
  // Only existing warnings need writes. Batch them instead of issuing one
  // request per invoice line and extending every normal QBO sync by minutes.
  for (const [reason, ids] of idsByReason) {
    for (let offset = 0; offset < ids.length; offset += 200) {
      const { error } = await (supabase.from("qbo_backlog_import_reviews") as any)
        .update({ status: "RESOLVED", resolved_at: new Date().toISOString(), resolution_note: reason })
        .in("qbo_invoice_line_id", ids.slice(offset, offset + 200)).eq("status", "OPEN");
      if (error) throw new Error(error.message);
    }
  }
}

/** Read-only candidate analysis. It never writes demand, queues, fulfillments, allocations, or inventory. */
export async function previewQboForwardIntake(firstPaymentByQboInvoiceId: Map<string, string>) {
  const supabase = getSupabaseAdmin();
  const [invoices, invoiceLines, orders, orderLines, products, aliases, resolutions] = await Promise.all([
    fetchAllRows<Invoice>((from, to) => supabase.from("qbo_invoices").select("id,qbo_invoice_id,invoice_number,customer_id,payment_status,invoice_date,created_at,raw_payload,customers(company_name,full_name)").order("id").range(from, to)),
    fetchAllRows<InvoiceLine>((from, to) => supabase.from("qbo_invoice_lines").select("id,qbo_invoice_id,qbo_line_id,qbo_sku,source_description,ordered_qty,product_id").order("id").range(from, to)),
    fetchAllRows<Order>((from, to) => supabase.from("shipping_orders").select("id,source_invoice_id,duplicate_of_order_id,cancellation_status,review_status,order_number,customer_id,legacy_customer_name,customers(company_name,full_name)").order("id").range(from, to) as unknown as PromiseLike<{ data: Order[] | null; error: { message: string } | null }>),
    fetchAllRows<OrderLine>((from, to) => supabase.from("shipping_order_lines").select("shipping_order_id,qbo_invoice_line_id,product_id,ordered_qty,fulfilled_qty,fulfillment_status").order("id").range(from, to)),
    fetchAllRows<{ id: string; sku: string | null }>((from, to) => supabase.from("products").select("id,sku").order("id").range(from, to)),
    fetchAllRows<{ product_id: string; alias: string | null }>((from, to) => supabase.from("product_aliases").select("product_id,alias").order("id").range(from, to)),
    fetchAllRows<{ qbo_invoice_line_id: string | null; status: string | null }>((from, to) => supabase.from("reviewed_obligation_resolutions").select("qbo_invoice_line_id,status").order("id").range(from, to)),
  ]);
  return buildQboForwardIntakePreview({ invoices, invoiceLines, orders, orderLines, products, aliases, resolutions }, firstPaymentByQboInvoiceId);
}

export type QboForwardIntakeSnapshot = {
  invoices: Invoice[]; invoiceLines: InvoiceLine[]; orders: Order[]; orderLines: OrderLine[];
  products: Array<{ id: string; sku: string | null }>;
  aliases: Array<{ product_id: string; alias: string | null }>;
  resolutions: Array<{ qbo_invoice_line_id: string | null; status: string | null }>;
};

/** Pure analysis: the presence of an invoice parent is not duplicate-line evidence. */
export function buildQboForwardIntakePreview(
  { invoices, invoiceLines, orders, orderLines, products, aliases, resolutions }: QboForwardIntakeSnapshot,
  firstPaymentByQboInvoiceId: Map<string, string>,
) {
  const productIdBySku = buildSafeQboProductIdByAlias(
    products,
    aliases.filter((alias) => !isUnsafeGlobalProductAlias(alias.alias)),
  );
  const linesByInvoice = new Map<string, InvoiceLine[]>();
  for (const line of invoiceLines) linesByInvoice.set(line.qbo_invoice_id, [...(linesByInvoice.get(line.qbo_invoice_id) ?? []), line]);
  const sourceLineById = new Map(invoiceLines.map((line) => [line.id, line]));
  const productSkuById = new Map(products.map((product) => [product.id, product.sku]));
  const exactOrderLineIds = new Set(orderLines.flatMap((line) => line.qbo_invoice_line_id ? [line.qbo_invoice_line_id] : []));
  const activeResolutionIds = new Set(resolutions.filter((row) => normalized(row.status) === "ACTIVE" && row.qbo_invoice_line_id).map((row) => String(row.qbo_invoice_line_id)));
  const eligibleInvoices = invoices.filter((invoice) => {
    const firstPaymentAt = firstPaymentByQboInvoiceId.get(invoice.qbo_invoice_id);
    return PAID_STATUSES.has(invoice.payment_status ?? "") && isWithinAutomaticQboIntake(firstPaymentAt, invoice.invoice_date);
  });

  return eligibleInvoices.map((invoice) => {
    const firstPaymentAt = firstPaymentByQboInvoiceId.get(invoice.qbo_invoice_id) ?? null;
    const priorityDate = qboIntakePriorityDate(firstPaymentAt, invoice.invoice_date);
    const canonicalParents = orders.filter((candidate) => candidate.source_invoice_id === invoice.id && !candidate.duplicate_of_order_id);
    const invoiceClosed = normalized(invoice.raw_payload?.PrivateNote) === "VOIDED"
      || canonicalParents.some((parent) => normalized(parent.cancellation_status) === "CANCELLED");
    const liveQuantities = Array.isArray(invoice.raw_payload?.Line) ? liveQuickBooksLineQuantities(invoice.raw_payload) : null;
    const parentLines = orderLines.filter((orderLine) => canonicalParents.some((parent) => parent.id === orderLine.shipping_order_id));
    const physicalParentLines = parentLines.filter((orderLine) => {
      const source = sourceLineById.get(orderLine.qbo_invoice_line_id ?? "");
      return isInventoryDemandQuickbooksLine({ ...orderLine, qbo_sku: source?.qbo_sku ?? productSkuById.get(orderLine.product_id ?? ""), source_description: source?.source_description });
    });
    // Never silently reopen a completed/historical or unapproved order just
    // because its current QBO snapshot contains an unmatched line. Those
    // lifecycle conflicts require review, independently of payment dating.
    const parentRequiresReview = canonicalParents.some((parent) => normalized(parent.review_status) !== "APPROVED")
      || (physicalParentLines.length > 0 && physicalParentLines.every((orderLine) => CLOSED_STATUSES.has(normalized(orderLine.fulfillment_status))
        || Number(orderLine.fulfilled_qty ?? 0) >= Number(orderLine.ordered_qty ?? 0)));
    const lines = (linesByInvoice.get(invoice.id) ?? []).map((line) => {
      const productId = line.product_id ?? qboSkuCandidates(line.qbo_sku).map((sku) => productIdBySku.get(normalized(sku))).find(Boolean) ?? null;
      // Only an unlinked representation of this item/quantity is ambiguous.
      // Another product already linked to its own QBO line is a sibling, not
      // evidence that this missing item is duplicated. Keep shipped legacy
      // matches in review too: importing them would resurrect old demand.
      const unmatchedParentLines = parentLines.filter((orderLine) => !orderLine.qbo_invoice_line_id
        && Number(orderLine.ordered_qty ?? 0) === Number(line.ordered_qty ?? 0));
      const hasUnlinkedRepresentation = unmatchedParentLines.some((orderLine) => !orderLine.product_id || orderLine.product_id === productId);
      const manualMatch = Boolean(productId) && orders.some((candidate) => candidate.source_invoice_id !== invoice.id && !candidate.duplicate_of_order_id && candidate.order_number && normalized(candidate.order_number) === normalized(invoice.invoice_number) && sameKnownCustomer(candidate, invoice) && orderLines.some((orderLine) => orderLine.shipping_order_id === candidate.id && orderLine.product_id === productId && Number(orderLine.ordered_qty ?? 0) === Number(line.ordered_qty ?? 0)));
      const terminal = invoiceClosed || (liveQuantities !== null && !liveQuantities.has(String(line.qbo_line_id)))
        || activeResolutionIds.has(line.id) || orderLines.some((orderLine) => orderLine.qbo_invoice_line_id === line.id && (CLOSED_STATUSES.has(normalized(orderLine.fulfillment_status)) || Number(orderLine.fulfilled_qty ?? 0) >= Number(orderLine.ordered_qty ?? 0)));
      const liveQuantityMismatch = liveQuantities !== null && liveQuantities.has(String(line.qbo_line_id))
        && liveQuantities.get(String(line.qbo_line_id)) !== Number(line.ordered_qty ?? 0);
      return { qboInvoiceLineId: line.id, sku: line.qbo_sku, quantity: Number(line.ordered_qty ?? 0), productId, decision: classifyQboForwardIntakeLine({ isPaymentEligible: true, isInventoryDemandLine: isInventoryDemandQuickbooksLine({ ...line, product_id: productId }), hasExactExistingLine: exactOrderLineIds.has(line.id), hasTerminalOrReviewedResolution: terminal, hasMappedProduct: Boolean(productId), hasPossibleManualDuplicate: manualMatch || hasUnlinkedRepresentation || canonicalParents.length > 1 || parentRequiresReview, hasConflictingSkuIdentity: liveQuantityMismatch || (unmatchedParentLines.length > 0 && !hasUnlinkedRepresentation) }) };
    });
    const decision = summarizeQboInvoiceIntake(lines.map((line) => line.decision));
    return { qboInvoiceId: invoice.id, invoiceNumber: invoice.invoice_number, customerName: customerName(invoice), firstPaymentAt, invoiceDate: invoice.invoice_date, priorityDate, priorityDateSource: firstPaymentAt ? "FIRST_PAYMENT" as const : "INVOICE_DATE" as const, decision, lines };
  }).sort((left, right) => String(left.priorityDate).localeCompare(String(right.priorityDate)) || String(left.invoiceNumber).localeCompare(String(right.invoiceNumber)));
}

/** Writes demand only for globally enabled, clean QBO candidates. It never creates fulfillment, allocation, or inventory records. */
export async function executeQboForwardIntake(firstPaymentByQboInvoiceId: Map<string, string>) {
  const supabase = getSupabaseAdmin();
  const preview = await previewQboForwardIntake(firstPaymentByQboInvoiceId);
  await resolveObsoleteForwardIntakeReviews(preview);
  const candidates = selectAutomaticForwardIntakeCandidates(preview);
  const reviewCandidates = selectForwardIntakeReviewCandidates(preview);
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
      .select("id")
      .eq("source_invoice_id", invoice.id)
      .is("duplicate_of_order_id", null)
      .maybeSingle();
    if (orderLookupError) throw new Error(orderLookupError.message);
    let order: { id: string } | null = existingOrder;
    if (!order) {
      const customer = invoice.customers as unknown as { company_name: string | null; full_name: string | null } | null;
      const { data: createdOrder, error: orderError } = await supabase.from("shipping_orders").insert({
        customer_id: invoice.customer_id,
        source_invoice_id: invoice.id,
        order_number: invoice.invoice_number,
        source_type: "QBO_INVOICE",
        review_status: "APPROVED",
        legacy_customer_name: customer?.company_name ?? customer?.full_name ?? null,
        first_payment_at: candidate.firstPaymentAt,
      } as never).select("id").single();
      if (orderError || !createdOrder) {
        if (orderError?.code === "23505") continue;
        throw new Error(orderError?.message ?? "Could not create forward-intake order.");
      }
      order = createdOrder;
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
      // Successful exact-line creation (or its unique-key retry) supersedes
      // the old false duplicate warning; do not leave contradictory screens.
      const { data: represented, error: representedError } = await supabase.from("shipping_order_lines")
        .select("id").eq("qbo_invoice_line_id", sourceLine.id).limit(1);
      if (representedError) throw new Error(representedError.message);
      if (represented?.length) {
        const { error } = await (supabase.from("qbo_backlog_import_reviews") as any)
          .update({ status: "RESOLVED", resolved_at: new Date().toISOString(), resolution_note: "Exact QBO line is represented in OCC. No stock or fulfillment changed." })
          .eq("qbo_invoice_line_id", sourceLine.id).eq("status", "OPEN");
        if (error) throw new Error(error.message);
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
