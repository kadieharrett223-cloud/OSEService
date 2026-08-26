"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  clearAdminUnlock,
  isAdminUnlockedForUser,
  isValidAdminCode,
  unlockAdminForUser,
} from "@/lib/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { recalculateProductQueues } from "@/lib/product-queue";
import { classifyQboBacklogLine } from "@/lib/orders/qbo-backlog-classifier";
import { qboSkuCandidates } from "@/lib/orders/quickbooks-refresh";
import { revalidateOrdersProjection } from "@/lib/orders/orders-projection-cache";
import {
  disconnectQuickbooksConnection,
  getQuickbooksFirstPaymentDates,
  syncQuickbooksInvoices,
} from "@/lib/quickbooks/integration";

function generateInternalAccessCode() {
  return `AUTO-${crypto.randomUUID()}`;
}

async function requireSettingsAdmin() {
  const user = await requireUser();
  const unlocked = await isAdminUnlockedForUser(user.id);
  if (!unlocked) {
    redirect("/settings?error=Admin+code+required");
  }
  return user;
}

export async function unlockSettingsAdminAction(formData: FormData) {
  const user = await requireUser();
  const code = String(formData.get("admin_code") ?? "").trim();

  if (!isValidAdminCode(code)) {
    redirect("/settings?error=Invalid+admin+code");
  }

  await unlockAdminForUser(user.id);
  redirect("/settings?message=Admin+access+enabled");
}

export async function lockSettingsAdminAction() {
  await requireUser();
  await clearAdminUnlock();
  redirect("/settings?message=Admin+access+locked");
}

export async function createAccessUserAction(formData: FormData) {
  await requireSettingsAdmin();
  const supabase = getSupabaseAdmin();

  const fullName = String(formData.get("full_name") ?? "").trim();
  const accessCode = generateInternalAccessCode();

  if (!fullName) {
    redirect("/settings?error=Name+is+required");
  }

  const { error } = await supabase.from("access_users").insert({
    full_name: fullName,
    access_code: accessCode,
    is_active: true,
  });

  if (error) {
    redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/settings");
  redirect("/settings?message=Access+user+created");
}

export async function setAccessUserActiveAction(formData: FormData) {
  await requireSettingsAdmin();
  const supabase = getSupabaseAdmin();

  const userId = String(formData.get("user_id") ?? "").trim();
  const nextActive = String(formData.get("is_active") ?? "false") === "true";

  if (!userId) {
    redirect("/settings?error=Missing+user");
  }

  const { error } = await supabase
    .from("access_users")
    .update({ is_active: nextActive })
    .eq("id", userId);

  if (error) {
    redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/settings");
}

export async function connectQuickbooksAction() {
  await requireSettingsAdmin();
  redirect("/api/integrations/quickbooks/connect");
}

export async function syncQuickbooksAction() {
  await requireSettingsAdmin();

  try {
    const result = await syncQuickbooksInvoices();
    revalidatePath("/");
    revalidatePath("/settings");
    revalidatePath("/cases/new");
    revalidatePath("/shipping-review");
    revalidateOrdersProjection();
    revalidatePath("/orders");
    revalidatePath("/orders/[id]", "page");
    redirect(`/settings?message=${encodeURIComponent(`QuickBooks sync complete: ${result.invoiceCount} invoices, ${result.customerCount} customers, ${result.ordersUpdated ?? 0} first-payment dates updated.`)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "QuickBooks sync failed.";
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }
}

const QBO_BACKLOG_CUTOFF = Date.parse("2026-08-07T00:00:00.000Z");
const PAID_QBO_STATUSES = new Set(["Paid", "Partially Paid"]);
const CLOSED_LINE_STATUSES = new Set(["FULFILLED", "CANCELLED", "DENIED", "REMOVED", "REPLACED"]);

type QboInvoice = {
  id: string;
  qbo_invoice_id: string;
  invoice_number: string | null;
  customer_id: string | null;
  payment_status: string | null;
  customers?: { company_name: string | null; full_name: string | null } | null;
};
type QboInvoiceLine = {
  id: string;
  qbo_invoice_id: string;
  qbo_line_id: string | null;
  qbo_sku: string | null;
  source_description: string | null;
  ordered_qty: number | null;
  product_id: string | null;
};
type BacklogOrder = {
  id: string;
  source_invoice_id: string | null;
  duplicate_of_order_id: string | null;
  order_number: string | null;
  customer_id: string | null;
  legacy_customer_name: string | null;
  customers?: { company_name: string | null; full_name: string | null } | null;
};
type BacklogOrderLine = {
  id: string;
  shipping_order_id: string;
  qbo_invoice_line_id: string | null;
  product_id: string | null;
  ordered_qty: number | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
  approval_status: string | null;
  fulfillment_status: string | null;
};
type InventoryTransaction = { product_id: string; bucket: string; delta: number | null };

function normalizedText(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

function customerName(row: { customers?: { company_name: string | null; full_name: string | null } | null }) {
  return row.customers?.company_name ?? row.customers?.full_name ?? null;
}

function isPhysicalQboLine(line: QboInvoiceLine) {
  const text = `${line.qbo_sku ?? ""} ${line.source_description ?? ""}`.toLowerCase();
  return Number(line.ordered_qty ?? 0) > 0
    && !/^note\b/.test(text)
    && !/discount|shipping|freight|delivery|sales tax|tax adjustment|\bservice\b|\binstall(?:ation)?\b/.test(text);
}

function isClosedOrderLine(line: BacklogOrderLine) {
  return CLOSED_LINE_STATUSES.has(normalizedText(line.fulfillment_status))
    || (Number(line.ordered_qty ?? line.approved_qty ?? 0) > 0 && Number(line.fulfilled_qty ?? 0) >= Number(line.ordered_qty ?? line.approved_qty ?? 0));
}

function isActiveDemandLine(line: BacklogOrderLine) {
  return ["APPROVED", "PARTIAL"].includes(normalizedText(line.approval_status))
    && !CLOSED_LINE_STATUSES.has(normalizedText(line.fulfillment_status))
    && Number(line.approved_qty ?? 0) > Number(line.fulfilled_qty ?? 0);
}

export async function importQualifiedQboBacklogAction() {
  await requireSettingsAdmin();
  const supabase = getSupabaseAdmin();
  const runId = crypto.randomUUID();

  try {
    const firstPaymentByQboInvoiceId = await getQuickbooksFirstPaymentDates();
    const [invoiceResult, invoiceLineResult, orderResult, orderLineResult, productResult, aliasResult, resolutionResult, inventoryResult] = await Promise.all([
      supabase.from("qbo_invoices").select("id,qbo_invoice_id,invoice_number,customer_id,payment_status,customers(company_name,full_name)"),
      supabase.from("qbo_invoice_lines").select("id,qbo_invoice_id,qbo_line_id,qbo_sku,source_description,ordered_qty,product_id"),
      supabase.from("shipping_orders").select("id,source_invoice_id,duplicate_of_order_id,order_number,customer_id,legacy_customer_name,customers(company_name,full_name)"),
      supabase.from("shipping_order_lines").select("id,shipping_order_id,qbo_invoice_line_id,product_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status"),
      supabase.from("products").select("id,sku"),
      supabase.from("product_aliases").select("product_id,alias"),
      supabase.from("reviewed_obligation_resolutions").select("qbo_invoice_line_id,status"),
      supabase.from("inventory_transactions").select("product_id,bucket,delta"),
    ]);
    const firstError = [invoiceResult.error, invoiceLineResult.error, orderResult.error, productResult.error, aliasResult.error, resolutionResult.error, inventoryResult.error].find(Boolean);
    if (firstError) throw new Error(firstError.message);

    const invoices = (invoiceResult.data ?? []) as unknown as QboInvoice[];
    const invoiceLines = (invoiceLineResult.data ?? []) as unknown as QboInvoiceLine[];
    const orders = (orderResult.data ?? []) as unknown as BacklogOrder[];
    const orderLines = (orderLineResult.data ?? []) as unknown as BacklogOrderLine[];
    if (orderLineResult.error) throw new Error(orderLineResult.error.message);
    const inventoryTransactions = (inventoryResult.data ?? []) as unknown as InventoryTransaction[];
    const productIdBySku = new Map<string, string>();
    for (const product of productResult.data ?? []) productIdBySku.set(normalizedText(product.sku), product.id);
    for (const alias of aliasResult.data ?? []) productIdBySku.set(normalizedText(alias.alias), alias.product_id);

    const linesByInvoice = new Map<string, QboInvoiceLine[]>();
    for (const line of invoiceLines) linesByInvoice.set(line.qbo_invoice_id, [...(linesByInvoice.get(line.qbo_invoice_id) ?? []), line]);
    const orderByInvoice = new Map(orders.filter((order) => order.source_invoice_id && !order.duplicate_of_order_id).map((order) => [order.source_invoice_id!, order]));
    const exactOrderLines = new Map(orderLines.filter((line) => line.qbo_invoice_line_id).map((line) => [line.qbo_invoice_line_id!, line]));
    const resolutions = (resolutionResult.data ?? []) as unknown as Array<{ qbo_invoice_line_id: string | null; status: string | null }>;
    const activeResolutionLineIds = new Set(resolutions
      .filter((resolution) => normalizedText(resolution.status) === "ACTIVE" && resolution.qbo_invoice_line_id)
      .map((resolution) => String(resolution.qbo_invoice_line_id)));
    const baselineSoldByProduct = new Map<string, number>();
    for (const line of orderLines) {
      const parent = orders.find((order) => order.id === line.shipping_order_id);
      if (!line.product_id || parent?.duplicate_of_order_id || !isActiveDemandLine(line)) continue;
      baselineSoldByProduct.set(line.product_id, (baselineSoldByProduct.get(line.product_id) ?? 0) + Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
    }
    const onFloorByProduct = new Map<string, number>();
    for (const transaction of inventoryTransactions) {
      if (normalizedText(transaction.bucket) !== "ON_FLOOR") continue;
      onFloorByProduct.set(transaction.product_id, (onFloorByProduct.get(transaction.product_id) ?? 0) + Number(transaction.delta ?? 0));
    }

    let imported = 0;
    let alreadyPresent = 0;
    let closed = 0;
    let manualReview = 0;
    let unmappedReview = 0;
    const affectedProductIds = new Set<string>();

    for (const invoice of invoices) {
      const firstPaymentAt = firstPaymentByQboInvoiceId.get(invoice.qbo_invoice_id);
      if (!PAID_QBO_STATUSES.has(invoice.payment_status ?? "") || !firstPaymentAt || Date.parse(firstPaymentAt) < QBO_BACKLOG_CUTOFF) continue;

      let order = orderByInvoice.get(invoice.id) ?? null;
      for (const line of (linesByInvoice.get(invoice.id) ?? []).filter(isPhysicalQboLine)) {
        const productId = line.product_id ?? qboSkuCandidates(line.qbo_sku).map((sku) => productIdBySku.get(sku)).find(Boolean) ?? null;
        const exactLine = exactOrderLines.get(line.id) ?? null;
        const strongManualMatch = !exactLine && Boolean(productId) && orders.some((candidate) => {
          if (candidate.source_invoice_id === invoice.id || candidate.duplicate_of_order_id) return false;
          const candidateCustomer = customerName(candidate);
          const invoiceCustomer = customerName(invoice);
          const customerMatches = candidate.customer_id === invoice.customer_id || (Boolean(candidateCustomer) && normalizedText(candidateCustomer) === normalizedText(invoiceCustomer));
          if (!customerMatches || !candidate.order_number || normalizedText(candidate.order_number) !== normalizedText(invoice.invoice_number)) return false;
          return orderLines.some((candidateLine) => candidateLine.shipping_order_id === candidate.id
            && candidateLine.product_id === productId
            && Number(candidateLine.ordered_qty ?? 0) === Number(line.ordered_qty ?? 0));
        });
        const decision = classifyQboBacklogLine({
          hasExactExistingLine: Boolean(exactLine),
          hasTerminalOrReviewedResolution: Boolean(exactLine && isClosedOrderLine(exactLine)) || activeResolutionLineIds.has(line.id),
          hasMappedProduct: Boolean(productId),
          hasPossibleManualDuplicate: strongManualMatch,
        });
        const { error: auditError } = await supabase.from("audit_log").insert({
          entity_type: "qbo_backlog_import",
          action: "QBO_BACKLOG_CLASSIFIED",
          details: {
            run_id: runId,
            decision,
            qbo_invoice_line_id: line.id,
            invoice_number: invoice.invoice_number,
            customer_name: customerName(invoice),
            first_payment_at: firstPaymentAt,
            qbo_sku: line.qbo_sku,
            source_description: line.source_description,
            quantity: line.ordered_qty ?? 0,
            product_id: productId,
          } as never,
        });
        if (auditError) throw new Error(auditError.message);

        if (decision === "ALREADY PRESENT — SKIPPED") { alreadyPresent += 1; continue; }
        if (decision === "CLOSED — SKIPPED") { closed += 1; continue; }
        if (decision === "UNMAPPED — REVIEW") {
          unmappedReview += 1;
          const { error } = await (supabase.from("manual_product_mapping_queue") as any).upsert({
            source_sku: line.qbo_sku ?? "UNMAPPED_QBO_LINE",
            source_description: line.source_description,
            customer_name: customerName(invoice),
            invoice_number: invoice.invoice_number,
            quantity: line.ordered_qty ?? 0,
            source_system: "QBO_BACKLOG",
            source_record_id: line.id,
            first_payment_at: firstPaymentAt,
          }, { onConflict: "source_system,source_record_id" });
          if (error) throw new Error(error.message);
          continue;
        }
        if (decision === "MANUAL DUPLICATE — REVIEW") {
          manualReview += 1;
          const { error } = await (supabase.from("qbo_backlog_import_reviews") as any).upsert({
            qbo_invoice_line_id: line.id,
            review_type: "MANUAL_DUPLICATE",
            first_payment_at: firstPaymentAt,
            invoice_number: invoice.invoice_number,
            customer_name: customerName(invoice),
            qbo_sku: line.qbo_sku,
            source_description: line.source_description,
            quantity: line.ordered_qty ?? 0,
          }, { onConflict: "qbo_invoice_line_id" });
          if (error) throw new Error(error.message);
          continue;
        }

        if (!order) {
          const { data, error } = await supabase.from("shipping_orders").insert({
            customer_id: invoice.customer_id,
            source_invoice_id: invoice.id,
            order_number: invoice.invoice_number,
            source_type: "QBO_INVOICE",
            review_status: "APPROVED",
            priority: "NORMAL",
            legacy_customer_name: customerName(invoice),
            first_payment_at: firstPaymentAt,
            notes: "Imported from qualifying QuickBooks payment activity.",
          } as never).select("id").single();
          if (error || !data) throw new Error(error?.message ?? `Could not create order for invoice ${invoice.invoice_number ?? invoice.id}`);
          order = { id: data.id, source_invoice_id: invoice.id, duplicate_of_order_id: null, order_number: invoice.invoice_number, customer_id: invoice.customer_id, legacy_customer_name: customerName(invoice) };
          orderByInvoice.set(invoice.id, order);
        } else {
          const { error } = await supabase.from("shipping_orders").update({ first_payment_at: firstPaymentAt } as never).eq("id", order.id).is("first_payment_at", null);
          if (error) throw new Error(error.message);
        }

        if (!productId) throw new Error(`Mapped product missing for QuickBooks invoice line ${line.id}`);
        const orderedQuantity = Number(line.ordered_qty ?? 0);

        const { error } = await supabase.from("shipping_order_lines").insert({
          shipping_order_id: order.id,
          qbo_invoice_line_id: line.id,
          product_id: productId,
          ordered_qty: orderedQuantity,
          approved_qty: orderedQuantity,
          fulfilled_qty: 0,
          cancelled_qty: 0,
          approval_status: "APPROVED",
          warehouse_status: "ON_FLOOR",
          allocation_status: "UNALLOCATED",
          fulfillment_status: "PENDING",
          priority: "NORMAL",
          source_event_key: `QBO_INVOICE_LINE:${invoice.qbo_invoice_id}:${line.qbo_line_id ?? line.id}`,
          legacy_item_code: line.qbo_sku,
        });
        if (error && error.code !== "23505") throw new Error(error.message);
        if (!error) {
          imported += 1;
          affectedProductIds.add(productId);
          exactOrderLines.set(line.id, { id: line.id, shipping_order_id: order.id, qbo_invoice_line_id: line.id, product_id: productId, ordered_qty: orderedQuantity, approved_qty: orderedQuantity, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING" });
        } else {
          alreadyPresent += 1;
        }
      }
    }

    await recalculateProductQueues([...affectedProductIds]);
    const { error: snapshotError } = await supabase.from("audit_log").insert([...affectedProductIds].map((productId) => ({
      entity_type: "qbo_backlog_import",
      action: "QBO_BACKLOG_PRODUCT_SNAPSHOT",
      details: {
        run_id: runId,
        product_id: productId,
        on_floor_before: onFloorByProduct.get(productId) ?? 0,
        sold_before: baselineSoldByProduct.get(productId) ?? 0,
      } as never,
    })));
    if (snapshotError) throw new Error(snapshotError.message);
    revalidatePath("/inventory");
    revalidatePath("/product-mappings");
    revalidateOrdersProjection();
    revalidatePath("/orders");
    revalidatePath("/settings");
    redirect(`/settings?message=${encodeURIComponent(`QBO backlog run ${runId}: ${imported} imported, ${alreadyPresent} already present, ${closed} closed, ${manualReview} manual reviews, ${unmappedReview} unmapped reviews.`)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "QuickBooks backlog import failed.";
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }
}

export async function disconnectQuickbooksAction() {
  await requireSettingsAdmin();

  try {
    await disconnectQuickbooksConnection();
    revalidatePath("/");
    revalidatePath("/settings");
    redirect("/settings?message=QuickBooks+disconnected");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to disconnect QuickBooks.";
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }
}
