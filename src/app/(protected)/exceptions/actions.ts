"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { revalidateCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-cache";
import { revalidateErpHealth } from "@/lib/orders/erp-health-cache";
import { revalidateOrdersProjection } from "@/lib/orders/orders-projection-cache";
import { canApproveHistoricalQboIntakeLine, isInventoryDemandQuickbooksLine } from "@/lib/orders/qbo-forward-intake";
import { qboSkuCandidates } from "@/lib/orders/quickbooks-refresh";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { recalculateProductQueues } from "@/lib/product-queue";

export async function rebuildExceptionQueueAction(formData: FormData) {
  await requireUser();
  const productId = String(formData.get("product_id") ?? "").trim();
  if (!productId) return;
  await recalculateProductQueues([productId]);
  revalidateCanonicalCustomerQueue();
  revalidateErpHealth();
  revalidatePath("/exceptions");
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
}

const PAID = new Set(["PAID", "PARTIALLY PAID"]);
const CLOSED = new Set(["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);
const DISPOSITIONS = new Set(["APPROVED", "ALREADY_SATISFIED", "DUPLICATE", "CLOSED"]);
const upper = (value: unknown) => String(value ?? "").trim().toUpperCase();
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Records one reviewed historical QBO line. Approval rechecks live identity and never changes inventory or fulfillment evidence. */
export async function reviewHistoricalQboIntakeAction(formData: FormData) {
  const user = await requireUser();
  const qboInvoiceLineId = String(formData.get("qbo_invoice_line_id") ?? "").trim();
  const disposition = upper(formData.get("disposition"));
  const reviewNote = String(formData.get("review_note") ?? "").trim();
  if (!isUuid(qboInvoiceLineId) || !DISPOSITIONS.has(disposition)) throw new Error("Invalid historical QBO intake review request.");
  const db = getSupabaseAdmin();
  type SourceLine = { id: string; qbo_invoice_id: string; qbo_line_id: string | null; qbo_sku: string | null; source_description: string | null; ordered_qty: number; product_id: string | null; qbo_invoices: { id: string; qbo_invoice_id: string | null; invoice_number: string | null; payment_status: string | null; customer_id: string | null; raw_payload?: { PrivateNote?: string | null } | null } | null };
  type ExistingLine = { id: string; shipping_order_id: string; approved_qty: number | null; fulfilled_qty: number | null; approval_status: string | null; fulfillment_status: string | null };
  type Parent = { id: string; duplicate_of_order_id: string | null; cancellation_status: string | null; source_type: string | null };
  const sourceResult = await (db.from("qbo_invoice_lines") as any).select("id,qbo_invoice_id,qbo_line_id,qbo_sku,source_description,ordered_qty,product_id,qbo_invoices(id,qbo_invoice_id,invoice_number,payment_status,customer_id,raw_payload)").eq("id", qboInvoiceLineId).maybeSingle();
  const source = sourceResult.data as SourceLine | null;
  const sourceError = sourceResult.error as { message: string } | null;
  if (sourceError || !source?.qbo_invoices) throw new Error(sourceError?.message ?? "QBO source line no longer exists.");
  const invoice = source.qbo_invoices;
  const [{ data: rawSourceLines }, { data: resolutions }, { data: duplicateReview }, { data: rawCandidates }] = await Promise.all([
    (db.from("shipping_order_lines") as any).select("id,shipping_order_id,approved_qty,fulfilled_qty,approval_status,fulfillment_status").eq("qbo_invoice_line_id", source.id),
    (db.from("reviewed_obligation_resolutions") as any).select("qbo_invoice_line_id,status").eq("qbo_invoice_line_id", source.id).eq("status", "ACTIVE"),
    (db.from("qbo_backlog_import_reviews") as any).select("id,status").eq("qbo_invoice_line_id", source.id).eq("status", "OPEN").maybeSingle(),
    (db.from("shipping_orders") as any).select("id,duplicate_of_order_id,cancellation_status,source_type,created_at").eq("source_invoice_id", invoice.id).order("created_at", { ascending: true }),
  ]);
  const sourceLines = (rawSourceLines ?? []) as ExistingLine[];
  const candidates = (rawCandidates ?? []) as Parent[];
  const aliases = qboSkuCandidates(source.qbo_sku);
  const { data: aliasRows } = aliases.length ? await db.from("product_aliases").select("product_id,alias").in("alias", aliases) : { data: [] };
  const productId = source.product_id ?? aliasRows?.[0]?.product_id ?? null;
  const existingLines = sourceLines ?? [];
  const terminal = (resolutions ?? []).length > 0 || existingLines.some((line) => CLOSED.has(upper(line.fulfillment_status)) || Number(line.fulfilled_qty ?? 0) >= Number(source.ordered_qty ?? 0));
  const open = existingLines.some((line) => Number(line.approved_qty ?? 0) > Number(line.fulfilled_qty ?? 0) && ["APPROVED", "PARTIAL"].includes(upper(line.approval_status)) && !CLOSED.has(upper(line.fulfillment_status)));
  const voided = upper(invoice.raw_payload?.PrivateNote) === "VOIDED";
  const canApprove = canApproveHistoricalQboIntakeLine({ isPaid: PAID.has(upper(invoice.payment_status)), isPhysicalLine: isInventoryDemandQuickbooksLine(source), hasMappedProduct: Boolean(productId), hasTerminalResolution: terminal, hasOpenRepresentation: open, hasOpenManualDuplicateReview: Boolean(duplicateReview), isVoided: voided });
  if (disposition === "APPROVED" && !canApprove) throw new Error("This QBO line no longer passes the historical intake approval guards.");
  if (disposition === "APPROVED") {
    if (!productId) throw new Error("This QBO line no longer has a mapped product.");
    let activeParent = candidates.find((order) => !order.duplicate_of_order_id && upper(order.cancellation_status) !== "CANCELLED" && order.source_type === "QBO_INVOICE");
    if (!activeParent) {
      const { data: createdParent, error: parentError } = await (db.from("shipping_orders") as any).insert({ customer_id: invoice.customer_id, source_invoice_id: invoice.id, order_number: invoice.invoice_number, source_type: "QBO_INVOICE", review_status: "APPROVED" }).select("id,duplicate_of_order_id,cancellation_status,source_type").single();
      if (parentError || !createdParent) throw new Error(parentError?.message ?? "Unable to create the exact QBO order parent.");
      activeParent = createdParent as Parent;
    }
    const pendingLine = existingLines.find((line) => Number(line.fulfilled_qty ?? 0) === 0 && !CLOSED.has(upper(line.fulfillment_status)));
    if (pendingLine) {
      const { error } = await db.from("shipping_order_lines").update({ approved_qty: source.ordered_qty, approval_status: "APPROVED", warehouse_status: "ON_FLOOR", fulfillment_status: "PENDING" }).eq("id", pendingLine.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await db.from("shipping_order_lines").insert({ shipping_order_id: activeParent.id, qbo_invoice_line_id: source.id, product_id: productId, ordered_qty: source.ordered_qty, approved_qty: source.ordered_qty, fulfilled_qty: 0, cancelled_qty: 0, approval_status: "APPROVED", warehouse_status: "ON_FLOOR", allocation_status: "UNALLOCATED", fulfillment_status: "PENDING", priority: "NORMAL", source_event_key: `QBO_INVOICE_LINE:${invoice.qbo_invoice_id}:${source.qbo_line_id}`, legacy_item_code: source.qbo_sku });
      if (error && error.code !== "23505") throw new Error(error.message);
    }
    await recalculateProductQueues([productId]);
  } else {
    const resolutionType = disposition === "ALREADY_SATISFIED" ? "HISTORICAL_FULFILLMENT" : disposition === "DUPLICATE" ? "DUPLICATE" : "CANCELLED_CLOSED";
    const { error } = await (db.from("reviewed_obligation_resolutions") as any).insert({ qbo_invoice_line_id: source.id, resolution_type: resolutionType, status: "ACTIVE", resolution_note: reviewNote || `Historical QBO intake review: ${disposition}`, reviewed_by: user.id });
    if (error) throw new Error(error.message);
  }
  const { error: reviewError } = await (db.from("historical_qbo_intake_reviews") as any).upsert({ qbo_invoice_line_id: source.id, disposition, review_note: reviewNote, reviewed_by: user.id, reviewed_at: new Date().toISOString() }, { onConflict: "qbo_invoice_line_id" });
  if (reviewError) throw new Error(reviewError.message);
  revalidateCanonicalCustomerQueue();
  revalidateErpHealth();
  revalidateOrdersProjection();
  revalidatePath("/orders");
  revalidatePath("/exceptions");
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
}
