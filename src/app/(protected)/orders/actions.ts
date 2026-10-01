"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { recalculateProductQueues } from "@/lib/product-queue";
import { revalidateCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-cache";
import { normalizeFulfillmentSource, shouldCreateWarehouseReservation, shouldMoveWarehouseInventory } from "@/lib/orders/fulfillment-source";
import { buildSafeQboProductIdByAlias, isNonInventoryQuickbooksLine, liveQuickBooksLineQuantities, planQuickbooksOrderRefresh, qboSkuCandidates, resolveInvoiceOrder } from "@/lib/orders/quickbooks-refresh";
import { resolveCanonicalOrderParent } from "@/lib/orders/order-identity";
import { revalidateErpHealth } from "@/lib/orders/erp-health-cache";
import { findLogicalFulfillmentOverages, isActiveSameInvoiceSiblingOwner, resolveSingleFulfillmentOwner } from "@/lib/orders/fulfillment-owner";
import { revalidateOrdersProjection } from "@/lib/orders/orders-projection-cache";
import { getOrderCancellationPostconditionErrors, type CancellationLineState } from "@/lib/orders/order-cancellation";
import { appendQuickbooksInternalMemoForOrder, syncQuickbooksInvoice } from "@/lib/quickbooks/integration";
import { shipmentMemoLabel } from "@/lib/orders/shipment-memo-label";
import { findShipmentEvidenceRepairs } from "@/lib/orders/shipment-evidence-reconciliation";

function revalidateOrdersList() {
  revalidateOrdersProjection();
  revalidatePath("/orders");
}

/**
 * Fulfillment changes customer demand, not just the order detail. Rebuild
 * positions and expire the shared projection after a confirmed fulfillment.
 * This is positions/cache work only; it never writes inventory transactions.
 */
async function refreshCustomerQueuesAfterFulfillment(productIds: Array<string | null | undefined>) {
  const mappedProductIds = productIds.filter((productId): productId is string => Boolean(productId));
  if (mappedProductIds.length > 0) await recalculateProductQueues(mappedProductIds);
  revalidateCanonicalCustomerQueue();
  revalidateErpHealth();
}

/**
 * Repairs only the derived line summary when its own completed OCC shipment
 * already proves fulfillment. It deliberately performs no inventory,
 * allocation, shipment, or order-status write: those were established by the
 * original shipment and must never be replayed by reconciliation.
 */
async function reconcileConfirmedShipmentEvidenceForOrder(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
) {
  const { data: rawLines, error: linesError } = await supabase
    .from("shipping_order_lines")
    .select("id,product_id,ordered_qty,approved_qty,fulfilled_qty")
    .eq("shipping_order_id", orderId);
  if (linesError) throw new Error(linesError.message);
  const lines = (rawLines ?? []) as Array<{
    id: string;
    product_id: string | null;
    ordered_qty: number | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
  }>;
  if (lines.length === 0) return 0;

  const lineIds = lines.map((line) => line.id);
  const [{ data: rawEvents, error: eventsError }, { data: shipments, error: shipmentsError }] = await Promise.all([
    supabase.from("fulfillments").select("shipping_order_line_id,fulfilled_qty,shipment_number").in("shipping_order_line_id", lineIds),
    supabase.from("order_shipments").select("id,shipment_number").eq("shipping_order_id", orderId),
  ]);
  if (eventsError) throw new Error(eventsError.message);
  if (shipmentsError) throw new Error(shipmentsError.message);
  const shipmentRows = (shipments ?? []) as Array<{ id: string; shipment_number: string | null }>;
  const shipmentIds = shipmentRows.map((shipment) => shipment.id);
  const { data: rawShipmentLines, error: shipmentLinesError } = shipmentIds.length > 0
    ? await supabase
      .from("order_shipment_lines")
      .select("shipping_order_line_id,quantity")
      .in("shipment_id", shipmentIds)
    : { data: [], error: null };
  if (shipmentLinesError) throw new Error(shipmentLinesError.message);

  const repairs = findShipmentEvidenceRepairs(
    lines,
    (rawEvents ?? []) as Array<{ shipping_order_line_id: string; fulfilled_qty: number | null; shipment_number: string | null }>,
    shipmentRows.map((shipment) => shipment.shipment_number),
    (rawShipmentLines ?? []) as Array<{ shipping_order_line_id: string; quantity: number | null }>,
  );
  for (const repair of repairs) {
    const { error } = await supabase
      .from("shipping_order_lines")
      .update({
        fulfilled_qty: repair.fulfilledQty,
        fulfillment_status: repair.complete ? "FULFILLED" : "PARTIALLY_FULFILLED",
        warehouse_status: repair.complete ? "FULFILLED" : "PARTIALLY_FULFILLED",
      })
      .eq("id", repair.lineId)
      // A concurrent normal fulfillment can only advance this number. Never
      // replace it with the older reconciliation snapshot.
      .lt("fulfilled_qty", repair.fulfilledQty);
    if (error) throw new Error(error.message);
  }
  if (repairs.length > 0) {
    await refreshCustomerQueuesAfterFulfillment(repairs.map((repair) => repair.productId));
    await writeOrderActivity(supabase, orderId, "SHIPMENT_EVIDENCE_RECONCILED", {
      line_count: repairs.length,
      source: "completed_occ_shipments",
    });
  }
  return repairs.length;
}

async function loadTableColumnSet(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  tableName: string,
  candidates: string[],
) {
  const columns = new Set<string>();

  for (const column of candidates) {
    const { error } = await supabase.from(tableName).select(column).limit(1);
    if (!error) {
      columns.add(column);
    }
  }

  return columns;
}

function filterPayloadByColumnSet<T extends Record<string, unknown>>(payload: T, columnSet: Set<string>) {
  const filtered: Partial<T> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (columnSet.has(key)) {
      filtered[key as keyof T] = value as T[keyof T];
    }
  }

  return filtered;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

type AuditDetails = Record<string, string | number | boolean | null>;

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "pdf", "mp4"]);
const NO_SHIPPABLE_LINES_ERROR = "No remaining physical inventory lines available for shipment selection";
const CLOSED_FULFILLMENT_STATES = new Set(["FULFILLED", "CANCELLED", "REMOVED", "DENIED"]);

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

function getPositiveNumber(formData: FormData, key: string) {
  const raw = Number(getString(formData, key) ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
}

async function assertOrderIsOperational(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
) {
  const { data, error } = await supabase
    .from("shipping_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();

  if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);
  if (!data) redirect("/orders?error=Order+not+found");
  const order = data as unknown as { cancellation_status?: string | null };
  if (String(order.cancellation_status ?? "").trim().toUpperCase() === "CANCELLED") {
    redirect(`/orders/${orderId}?error=Cancelled+orders+are+closed+and+cannot+be+changed+or+fulfilled`);
  }
}

function isPaidQuickbooksInvoice(status: string | null | undefined) {
  return String(status ?? "").trim().toUpperCase() === "PAID";
}

/** Payment-held exceptions are intentionally queued, but never shippable until a live QBO refresh confirms balance = 0. */
async function assertOrderCanShip(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
) {
  await assertOrderIsOperational(supabase, orderId);
  const { data: order, error } = await supabase
    .from("shipping_orders")
    .select("id,source_invoice_id,payment_hold,qbo_invoices(qbo_invoice_id,payment_status)")
    .eq("id", orderId)
    .maybeSingle();
  if (error || !order) redirect(`/orders/${orderId}?error=${encodeURIComponent(error?.message ?? "Order not found")}`);
  const heldOrder = order as unknown as { payment_hold?: boolean | null; qbo_invoices?: { qbo_invoice_id?: string | null; payment_status?: string | null } | null };
  if (!heldOrder.payment_hold) return;
  const qboInvoiceId = heldOrder.qbo_invoices?.qbo_invoice_id;
  if (!qboInvoiceId) redirect(`/orders/${orderId}?error=Payment+hold+cannot+be+cleared+because+the+QuickBooks+invoice+is+missing`);
  try {
    await syncQuickbooksInvoice(qboInvoiceId);
  } catch (refreshError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(`Payment hold: could not verify live QuickBooks balance (${refreshError instanceof Error ? refreshError.message : "refresh failed"})`)}`);
  }
  const { data: refreshedInvoice, error: refreshedError } = await supabase
    .from("qbo_invoices")
    .select("payment_status")
    .eq("qbo_invoice_id", qboInvoiceId)
    .maybeSingle();
  if (refreshedError || !isPaidQuickbooksInvoice(refreshedInvoice?.payment_status)) {
    redirect(`/orders/${orderId}?error=Payment+hold:+QuickBooks+must+show+a+zero+balance+before+shipping`);
  }
}

async function safeAccessUserId(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string | null | undefined,
) {
  if (!userId || !isUuid(userId)) return null;
  const { data } = await supabase.from("access_users").select("id").eq("id", userId).maybeSingle();
  return data?.id ?? null;
}

async function hasRemainingShippableLinesForOrder(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
) {
  const lineColumnSet = await loadTableColumnSet(supabase, "shipping_order_lines", ["fulfillment_source"]);
  const selectFields = lineColumnSet.has("fulfillment_source")
    ? "id, product_id, ordered_qty, approved_qty, fulfilled_qty, fulfillment_status, fulfillment_source"
    : "id, product_id, ordered_qty, approved_qty, fulfilled_qty, fulfillment_status";
  const { data, error } = await supabase
    .from("shipping_order_lines")
    .select(selectFields)
    .eq("shipping_order_id", orderId);

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as unknown as Array<{
    product_id: string | null;
    ordered_qty: number | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    fulfillment_status: string | null;
    fulfillment_source?: string | null;
  }>;

  return rows.some((line) => {
    if (!line.product_id) return false;
    if (!shouldMoveWarehouseInventory(line.fulfillment_source ?? "WAREHOUSE")) return false;
    const basis = Math.max(Number(line.approved_qty ?? 0), Number(line.ordered_qty ?? 0));
    const remaining = Math.max(0, basis - Number(line.fulfilled_qty ?? 0));
    if (remaining <= 0) return false;
    return !CLOSED_FULFILLMENT_STATES.has(String(line.fulfillment_status ?? "").trim().toUpperCase());
  });
}

async function resolveCanonicalSiblingOrderId(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
) {
  const { data: current } = await supabase
    .from("shipping_orders")
    .select("id, source_invoice_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!current?.source_invoice_id) return null;

  const { data: siblings } = await supabase
    .from("shipping_orders")
    .select("id, source_type, source_system, created_at, source_invoice_id")
    .eq("source_invoice_id", current.source_invoice_id)
    .order("created_at", { ascending: true });

  const canonical = resolveCanonicalOrderParent(siblings ?? []);
  if (!canonical?.id || canonical.id === orderId) return null;
  return canonical.id;
}

type FulfillmentCapacityLine = {
  id: string;
  shipping_order_id: string;
  product_id: string | null;
  qbo_invoice_line_id: string | null;
  ordered_qty: number | null;
  approved_qty: number | null;
  fulfilled_qty: number | null;
};

/** Reject a second warehouse deduction for the same exact QBO obligation across active sibling parents. */
async function assertLogicalFulfillmentCapacity(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  selectedLines: FulfillmentCapacityLine[],
  selectedQuantities: Map<string, number>,
) {
  const selectedOrderIds = [...new Set(selectedLines.map((line) => line.shipping_order_id))];
  const { data: selectedParents, error: selectedParentError } = await supabase
    .from("shipping_orders")
    .select("id,source_invoice_id")
    .in("id", selectedOrderIds);
  if (selectedParentError) throw new Error(selectedParentError.message);
  const sourceInvoiceIds = [...new Set((selectedParents ?? [])
    .map((parent) => parent.source_invoice_id)
    .filter((sourceInvoiceId): sourceInvoiceId is string => Boolean(sourceInvoiceId)))];
  if (sourceInvoiceIds.length === 0) return;

  const { data: siblingParents, error: siblingParentError } = await supabase
    .from("shipping_orders")
    .select("id")
    .in("source_invoice_id", sourceInvoiceIds)
    .is("duplicate_of_order_id", null);
  if (siblingParentError) throw new Error(siblingParentError.message);
  const activeSiblingOrderIds = (siblingParents ?? []).map((parent) => parent.id);
  if (activeSiblingOrderIds.length === 0) return;

  const { data: rawSiblingLines, error: siblingLineError } = await supabase
    .from("shipping_order_lines")
    .select("id,shipping_order_id,product_id,qbo_invoice_line_id,ordered_qty,approved_qty,fulfilled_qty")
    .in("shipping_order_id", activeSiblingOrderIds);
  if (siblingLineError) throw new Error(siblingLineError.message);
  const siblingLines = (rawSiblingLines ?? []) as unknown as FulfillmentCapacityLine[];
  const overages = findLogicalFulfillmentOverages(
    siblingLines,
    selectedLines.map((line) => ({ lineId: line.id, quantity: selectedQuantities.get(line.id) ?? 0 })),
  );
  if (overages.length > 0) {
    throw new Error("This QuickBooks invoice item is already fulfilled by its linked order record. No duplicate shipment or inventory deduction was made.");
  }
}

async function getLogicalOrderIds(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
) {
  const { data: order, error } = await supabase
    .from("shipping_orders")
    .select("id,source_invoice_id")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!order) return [];
  if (!order.source_invoice_id) return [order.id];

  const { data: siblings, error: siblingError } = await supabase
    .from("shipping_orders")
    .select("id")
    .eq("source_invoice_id", order.source_invoice_id);
  if (siblingError) throw new Error(siblingError.message);
  return Array.from(new Set((siblings ?? []).map((sibling) => sibling.id).concat(order.id)));
}

export async function completeServiceOnlyOrderAction(formData: FormData) {
  await requireUser();
  const orderId = getString(formData, "orderId");
  const adminClient = getSupabaseAdmin();
  if (!orderId) redirect("/orders?error=Missing+order+reference");
  await assertOrderIsOperational(adminClient, orderId);
  const { data: order } = await adminClient.from("shipping_orders").select("id,source_invoice_id").eq("id", orderId).maybeSingle();
  if (!order?.source_invoice_id) redirect(`/orders/${orderId}?error=Order+not+found`);
  const [{ data: operationalLines }, { data: invoiceLines }] = await Promise.all([
    adminClient.from("shipping_order_lines").select("id").eq("shipping_order_id", orderId),
    adminClient.from("qbo_invoice_lines").select("qbo_sku,source_description,ordered_qty").eq("qbo_invoice_id", order.source_invoice_id),
  ]);
  if ((operationalLines ?? []).length > 0 || (invoiceLines ?? []).some((line) => Number(line.ordered_qty ?? 0) > 0 && !isNonInventoryQuickbooksLine(line))) {
    redirect(`/orders/${orderId}?error=Physical+items+must+be+mapped+and+fulfilled+through+the+normal+workflow`);
  }
  const { error } = await adminClient.from("shipping_orders").update({ review_status: "FULFILLED" } as never).eq("id", orderId);
  if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);
  await writeOrderActivity(adminClient, orderId, "SERVICE_ONLY_ORDER_COMPLETED", { message: "Service-only invoice completed without inventory movement" });
  await syncQuickbooksFulfillmentMemo(adminClient, orderId, {
    eventKey: `order-archived:${orderId}`,
    message: "Order completed / archived in OCC",
  });
  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Service+invoice+completed`);
}

async function isVoidedQuickBooksOrder(supabase: ReturnType<typeof getSupabaseAdmin>, orderId: string) {
  const { data } = await supabase
    .from("shipping_orders")
    .select("qbo_invoices(raw_payload)")
    .eq("id", orderId)
    .maybeSingle();
  return String((data as { qbo_invoices?: { raw_payload?: { PrivateNote?: string | null } | null } | null } | null)?.qbo_invoices?.raw_payload?.PrivateNote ?? "").trim().toUpperCase() === "VOIDED";
}

export async function cancelVoidedOrderAction(formData: FormData) {
  await requireUser();
  const orderId = getString(formData, "orderId");
  const confirmation = getString(formData, "confirmation");
  const adminClient = getSupabaseAdmin();
  if (!orderId || confirmation !== "CONFIRM_CANCEL_VOIDED") redirect(`/exceptions?error=Cancellation+confirmation+required`);
  if (!(await isVoidedQuickBooksOrder(adminClient, orderId))) redirect(`/exceptions?error=Only+voided+QuickBooks+orders+can+be+cancelled+from+ERP+Health`);
  const logicalOrderIds = await getLogicalOrderIds(adminClient, orderId);
  const { data: affectedLines } = await adminClient.from("shipping_order_lines").select("product_id").in("shipping_order_id", logicalOrderIds).not("product_id", "is", null);
  const { error } = await adminClient.rpc("cancel_voided_order", { p_order_id: orderId, p_reason: "Voided in QuickBooks" } as never);
  if (error) redirect(`/exceptions?error=${encodeURIComponent(error.message)}`);
  await recalculateProductQueues((affectedLines ?? []).map((line) => line.product_id).filter((productId): productId is string => Boolean(productId)));
  revalidateErpHealth();
  revalidatePath("/exceptions");
  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/exceptions?message=Order+cancelled+in+ERP`);
}

export async function cancelOrderManuallyAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "orderId");
  const confirmation = getString(formData, "confirmation");
  const reason = normalizeReasonForStorage(getString(formData, "reason") ?? "");

  if (!orderId) redirect("/orders?error=Missing+order+reference");
  if (!(await isAdminUnlockedForUser(user.id))) {
    redirect(`/orders/${orderId}?error=Admin+mode+is+required+to+cancel+an+order`);
  }
  if (confirmation !== "CONFIRM_CANCEL_ORDER" || reason.length < 3) {
    redirect(`/orders/${orderId}?error=Cancellation+reason+and+confirmation+are+required`);
  }

  const adminClient = getSupabaseAdmin();
  const { data: orderData, error: orderError } = await adminClient
    .from("shipping_orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  const order = orderData as { id: string; source_invoice_id?: string | null; cancellation_status?: string | null } | null;
  if (orderError) redirect(`/orders/${orderId}?error=${encodeURIComponent(orderError.message)}`);
  if (!order) redirect("/orders?error=Order+not+found");
  const logicalOrderIds = await getLogicalOrderIds(adminClient, orderId);
  const { data: logicalParents, error: logicalParentsError } = await adminClient
    .from("shipping_orders")
    .select("*")
    .in("id", logicalOrderIds);
  if (logicalParentsError) redirect(`/orders/${orderId}?error=${encodeURIComponent(logicalParentsError.message)}`);
  const typedLogicalParents = (logicalParents ?? []) as unknown as Array<{ id: string; cancellation_status?: string | null }>;
  if (typedLogicalParents.length > 0 && typedLogicalParents.every((parent) => String(parent.cancellation_status ?? "").toUpperCase() === "CANCELLED")) {
    redirect(`/orders/${orderId}?message=Order+is+already+cancelled`);
  }

  const { data: affectedLines } = await adminClient
    .from("shipping_order_lines")
    .select("product_id")
    .in("shipping_order_id", logicalOrderIds)
    .not("product_id", "is", null);
  const { error } = await adminClient.rpc("cancel_voided_order", {
    p_order_id: orderId,
    p_reason: `Manual cancellation: ${reason}`,
  } as never);
  if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);

  const [{ data: verifiedOrderData }, { data: verifiedLineData, error: verificationQueryError }] = await Promise.all([
    adminClient.from("shipping_orders").select("*").in("id", logicalOrderIds),
    adminClient
      .from("shipping_order_lines")
      .select("id,shipping_order_id,ordered_qty,approved_qty,fulfilled_qty,approval_status,fulfillment_status,inventory_allocations(allocation_status)")
      .in("shipping_order_id", logicalOrderIds),
  ]);
  const verifiedOrders = (verifiedOrderData ?? []) as unknown as Array<{ id: string; cancellation_status?: string | null; review_status?: string | null }>;
  const verificationErrors = verificationQueryError
    ? [`verification_query_failed:${verificationQueryError.message}`]
    : [
        ...verifiedOrders.flatMap((verifiedOrder) => [
          ...getOrderCancellationPostconditionErrors(
            verifiedOrder.cancellation_status,
            (verifiedLineData ?? []).filter((line) => (line as { shipping_order_id?: string }).shipping_order_id === verifiedOrder.id) as unknown as CancellationLineState[],
          ),
          ...(String(verifiedOrder.review_status ?? "").toUpperCase() === "CANCELLED" ? [] : [`parent_review_not_cancelled:${verifiedOrder.id}`]),
        ]),
        ...(verifiedOrders.length === logicalOrderIds.length ? [] : ["logical_parent_verification_incomplete"]),
      ];
  if (verificationErrors.length > 0) {
    await writeOrderActivity(adminClient, orderId, "ORDER_CANCELLATION_VERIFICATION_FAILED", {
      message: verificationErrors.join(", "),
    });
    revalidateOrdersList();
    revalidatePath("/inventory");
    revalidatePath(`/orders/${orderId}`);
    redirect(`/orders/${orderId}?error=Order+was+cancelled+but+its+queue+cleanup+requires+review`);
  }

  await writeOrderActivity(adminClient, orderId, "ORDER_CANCELLED_MANUAL", {
    reason,
    cancelled_by: user.id,
  });
  await recalculateProductQueues(
    (affectedLines ?? []).map((line) => line.product_id).filter((productId): productId is string => Boolean(productId)),
  );
  revalidateErpHealth();
  revalidatePath("/exceptions");
  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect("/orders?tab=cancelled&message=Order+cancelled+and+removed+from+active+customer+queues");
}

/**
 * Reopens a manually cancelled logical invoice from its already-imported QBO
 * snapshot.  This deliberately does not restore released allocations or make
 * an inventory movement: reopening demand affects customer queues only.
 */
export async function reopenCancelledOrderAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "orderId");
  const confirmation = getString(formData, "confirmation");
  if (!orderId) redirect("/orders?error=Missing+order+reference");
  if (!(await isAdminUnlockedForUser(user.id))) {
    redirect(`/orders/${orderId}?error=Admin+mode+is+required+to+reopen+an+order`);
  }
  if (confirmation !== "CONFIRM_REOPEN_ORDER") {
    redirect(`/orders/${orderId}?error=Reopen+confirmation+is+required`);
  }

  const adminClient = getSupabaseAdmin();
  const { data: orderData, error: orderError } = await adminClient
    .from("shipping_orders")
    .select("id,source_invoice_id,cancellation_status")
    .eq("id", orderId)
    .maybeSingle();
  const order = orderData as unknown as { id: string; source_invoice_id: string | null; cancellation_status: string | null } | null;
  if (orderError) redirect(`/orders/${orderId}?error=${encodeURIComponent(orderError.message)}`);
  if (!order) redirect("/orders?error=Order+not+found");
  if (String(order.cancellation_status ?? "").toUpperCase() !== "CANCELLED") {
    redirect(`/orders/${orderId}?message=Order+is+already+active`);
  }

  const logicalOrderIds = await getLogicalOrderIds(adminClient, orderId);
  const { data: invoice, error: invoiceError } = order.source_invoice_id
    ? await adminClient
      .from("qbo_invoices")
      .select("id,qbo_invoice_id,invoice_number,raw_payload")
      .eq("id", order.source_invoice_id)
      .maybeSingle()
    : { data: null, error: null };
  if (invoiceError || !invoice) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(invoiceError?.message ?? "This cancelled order is not linked to a QuickBooks invoice")}`);
  }
  if (String((invoice.raw_payload as { PrivateNote?: string } | null)?.PrivateNote ?? "").trim().toUpperCase() === "VOIDED") {
    redirect(`/orders/${orderId}?error=This+QuickBooks+invoice+is+voided+and+cannot+be+reopened`);
  }

  // The database restoration RPC is the only approved path through the
  // immutable-cancellation guard. It restores no allocation and records a
  // durable audit entry that stock and shipment evidence stayed untouched.
  for (const logicalOrderId of logicalOrderIds) {
    const { error: restoreError } = await adminClient.rpc("restore_cancelled_order", {
      p_order_id: logicalOrderId,
      p_reason: "Manual OCC reopen confirmed by an administrator",
    } as never);
    if (restoreError) redirect(`/orders/${orderId}?error=${encodeURIComponent(restoreError.message)}`);
  }

  // The live-in-system QBO snapshot is the source of truth for line identity
  // and quantity.  This restores cancelled, unshipped lines to PENDING and
  // rebuilds their queues; it never restores an allocation or writes stock.
  await activateExistingQuickbooksOrder(adminClient, orderId, invoice);
  const { error: siblingReviewError } = await adminClient
    .from("shipping_orders")
    .update({ review_status: "APPROVED" })
    .in("id", logicalOrderIds);
  if (siblingReviewError) redirect(`/orders/${orderId}?error=${encodeURIComponent(siblingReviewError.message)}`);

  const { data: restoredLines, error: restoredLinesError } = await adminClient
    .from("shipping_order_lines")
    .select("product_id")
    .in("shipping_order_id", logicalOrderIds)
    .not("product_id", "is", null);
  if (restoredLinesError) redirect(`/orders/${orderId}?error=${encodeURIComponent(restoredLinesError.message)}`);
  await recalculateProductQueues((restoredLines ?? []).map((line) => line.product_id).filter((productId): productId is string => Boolean(productId)));
  await writeOrderActivity(adminClient, orderId, "ORDER_REOPENED_MANUAL", {
    reopened_by: user.id,
    source: "existing_quickbooks_snapshot",
    physical_inventory_changed: false,
    allocations_restored: false,
  });
  revalidateErpHealth();
  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Order+reopened+and+customer+queues+rebuilt+without+changing+stock`);
}

function getFileExtension(fileName: string) {
  if (!fileName.includes(".")) return "";
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function normalizeReasonForStorage(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function isAllowedAttachment(file: File) {
  const extension = getFileExtension(file.name);
  return ALLOWED_ATTACHMENT_EXTENSIONS.has(extension);
}

async function writeOrderActivity(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  action: string,
  details: AuditDetails,
) {
  if (!orderId || !isUuid(orderId)) return;

  await supabase.from("audit_log").insert({
    entity_type: "shipping_order",
    entity_id: orderId,
    action,
    details: details as never,
  });
}

/**
 * QBO memo syncing is intentionally outside the fulfillment transaction. A
 * failed external note must never change, roll back, or duplicate OCC stock,
 * allocations, shipments, line quantities, or order status.
 */
async function syncQuickbooksFulfillmentMemo(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  event: { eventKey: string; message: string; occurredAt?: string | Date },
) {
  try {
    const result = await appendQuickbooksInternalMemoForOrder(orderId, event);
    await writeOrderActivity(supabase, orderId, "QBO_INTERNAL_MEMO_SYNCED", {
      event_key: event.eventKey,
      result: result.status,
      qbo_invoice_id: "qboInvoiceId" in result ? result.qboInvoiceId ?? null : null,
    });
  } catch (error) {
    await writeOrderActivity(supabase, orderId, "QBO_INTERNAL_MEMO_SYNC_FAILED", {
      event_key: event.eventKey,
      error: error instanceof Error ? error.message : "QuickBooks internal memo sync failed.",
    });
  }
}

async function syncQuickbooksFullyShippedMemo(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  occurredAt?: string | Date,
) {
  const { data: rows, error } = await supabase
    .from("shipping_order_lines")
    .select("fulfillment_status")
    .eq("shipping_order_id", orderId);
  if (error || !rows?.length || !rows.every((line) => line.fulfillment_status === "FULFILLED")) return;

  await syncQuickbooksFulfillmentMemo(supabase, orderId, {
    eventKey: `order-fully-shipped:${orderId}`,
    message: "Order fully shipped / archived in OCC",
    occurredAt,
  });
}

type ShipmentMemoLine = {
  id: string;
  legacy_item_code?: string | null;
  products?: { sku?: string | null; canonical_name?: string | null } | null;
};

/** Builds display-only text for QBO; it never participates in fulfillment or inventory calculations. */
function describeShipmentItems(
  lines: ShipmentMemoLine[],
  quantityForLine: (line: ShipmentMemoLine) => number,
) {
  const items = lines
    .map((line) => {
      const quantity = quantityForLine(line);
      if (!Number.isFinite(quantity) || quantity <= 0) return null;
      const product = line.products;
      const label = shipmentMemoLabel({
        sku: product?.sku,
        canonicalName: product?.canonical_name,
        legacyItemCode: line.legacy_item_code,
      });
      return `${quantity} × ${label}`;
    })
    .filter((item): item is string => Boolean(item));

  return items.length > 0 ? `; Items: ${items.join(", ")}` : "";
}

async function recordFulfillmentInventory(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  lineId: string,
  productId: string | null,
  quantity: number,
  sourceEventKey: string,
  actorId?: string | null,
) {
  if (!productId) throw new Error("Cannot record shipment inventory without a mapped product");
  if (quantity <= 0) return;

  const { data: floorRows, error: floorError } = await supabase
    .from("inventory_transactions")
    .select("delta")
    .eq("product_id", productId)
    .eq("bucket", "ON_FLOOR");
  if (floorError) throw new Error(floorError.message);

  const currentFloor = (floorRows ?? []).reduce((sum, row) => sum + Number(row.delta ?? 0), 0);
  const floorAfter = currentFloor - quantity;
  const floorEvent = await supabase.from("inventory_transactions").upsert({
    product_id: productId,
    bucket: "ON_FLOOR",
    delta: floorAfter - currentFloor,
    before_qty: currentFloor,
    after_qty: floorAfter,
    reason: "Fulfillment completed",
    source_type: "FULFILLMENT",
    source_event_key: `${sourceEventKey}:ON_FLOOR`,
    shipping_order_line_id: lineId,
    actor_id: actorId ?? null,
  }, { onConflict: "source_type,source_event_key", ignoreDuplicates: true });
  if (floorEvent.error) throw new Error(floorEvent.error.message);
}

async function syncOrderSummaryState(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  trackingNumber: string | null,
  carrier: string | null,
) {
  const { data: lines, error: linesError } = await supabase
    .from("shipping_order_lines")
    .select("approval_status, warehouse_status, fulfillment_status, approved_qty, fulfilled_qty")
    .eq("shipping_order_id", orderId);

  if (linesError) {
    throw new Error(linesError.message);
  }

  const orderLines = (lines ?? []) as Array<{
    approval_status: string | null;
    warehouse_status: string | null;
    fulfillment_status: string | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
  }>;

  const hasLines = orderLines.length > 0;
  const allFulfilled = hasLines && orderLines.every((line) => (line.fulfillment_status ?? "PENDING") === "FULFILLED");
  const anyShipped = orderLines.some((line) => {
    const fulfilledQty = Number(line.fulfilled_qty ?? 0);
    return fulfilledQty > 0 || line.fulfillment_status === "PARTIALLY_FULFILLED";
  });
  const anyHold = orderLines.some((line) => line.approval_status === "HOLD" || line.warehouse_status === "HOLD");

  const reviewStatus = allFulfilled ? "FULFILLED" : anyHold ? "HOLD" : "APPROVED";
  const fulfillmentStatus = allFulfilled ? "FULFILLED" : anyShipped ? "PARTIALLY_FULFILLED" : "PENDING";

  const shippingOrderColumnSet = await loadTableColumnSet(supabase, "shipping_orders", [
    "review_status",
    "fulfillment_status",
    "tracking_number",
    "carrier",
  ]);

  const payload = filterPayloadByColumnSet({
    review_status: reviewStatus,
    fulfillment_status: fulfillmentStatus,
    tracking_number: trackingNumber,
    carrier,
  }, shippingOrderColumnSet);

  const { error: orderUpdateError } = await supabase
    .from("shipping_orders")
    .update(payload)
    .eq("id", orderId);

  if (orderUpdateError) {
    throw new Error(orderUpdateError.message);
  }
}

export async function updateOrderLineStatusAction(formData: FormData) {
  await requireUser();

  const lineId = formData.get("lineId")?.toString();
  const orderId = formData.get("orderId")?.toString();
  const action = formData.get("action")?.toString();
  const adminClient = getSupabaseAdmin();

  if (!lineId || !orderId || !action) {
    redirect(`/orders/${orderId ?? ""}`);
  }
  await assertOrderIsOperational(adminClient, orderId);

  const payload: {
    approval_status?: "APPROVED" | "HOLD";
    warehouse_status?: "ON_FLOOR" | "IN_WAREHOUSE" | "HOLD" | "FULFILLED";
    fulfillment_status?: "FULFILLED";
  } = {};
  let auditAction = "ORDER_LINE_STATUS_CHANGED";
  let auditDetails: AuditDetails = { action };

  switch (action) {
    case "approve":
      payload.approval_status = "APPROVED";
      payload.warehouse_status = "ON_FLOOR";
      auditAction = "ORDER_LINE_APPROVED";
      auditDetails = { action, line_id: lineId, approval_status: "APPROVED" };
      break;
    case "queue":
      payload.warehouse_status = "IN_WAREHOUSE";
      auditAction = "ORDER_LINE_QUEUED";
      auditDetails = { action, line_id: lineId, warehouse_status: "IN_WAREHOUSE" };
      break;
    case "fulfill":
      redirect(`/orders/${orderId}?error=Use+the+quantity-based+shipment+or+pickup+workflow+to+record+fulfillment`);
    case "hold":
      payload.approval_status = "HOLD";
      payload.warehouse_status = "HOLD";
      auditAction = "ORDER_LINE_HOLD";
      auditDetails = { action, line_id: lineId, approval_status: "HOLD" };
      break;
    default:
      break;
  }

  const { error } = await adminClient.from("shipping_order_lines").update(payload).eq("id", lineId);

  if (!error) {
    const { data: changedLine } = await adminClient.from("shipping_order_lines").select("product_id").eq("id", lineId).maybeSingle();
    if (changedLine?.product_id) await recalculateProductQueues([changedLine.product_id]);
    await writeOrderActivity(adminClient, orderId, auditAction, auditDetails);
  }

  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}

export async function moveOrderToWarehouseAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  const adminClient = getSupabaseAdmin();
  if (!orderId) redirect("/orders?error=Missing+order+reference");
  await assertOrderIsOperational(adminClient, orderId);

  const { data: lines, error: linesError } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, ordered_qty, approved_qty, fulfilled_qty, approval_status, fulfillment_status")
    .eq("shipping_order_id", orderId);

  if (linesError) redirect(`/orders/${orderId}?error=${encodeURIComponent(linesError.message)}`);

  if ((lines ?? []).length === 0) {
    redirect(`/orders/${orderId}?error=This+order+has+no+mapped+operational+lines.+Map+the+QuickBooks+SKUs+before+moving+items+to+the+warehouse.`);
  }

  const openLines = (lines ?? []).filter((line) =>
    line.product_id
    && Number(line.approved_qty ?? 0) > Number(line.fulfilled_qty ?? 0)
    && line.fulfillment_status !== "FULFILLED"
    && line.fulfillment_status !== "CANCELLED",
  );
  if (openLines.length === 0) redirect(`/orders/${orderId}?error=This+order+has+no+open+mapped+items+to+move+to+the+warehouse`);

  const { error: updateError } = await adminClient
    .from("shipping_order_lines")
    .update({
      approval_status: "APPROVED",
      warehouse_status: "IN_WAREHOUSE",
      fulfillment_status: "PENDING",
    })
    .eq("shipping_order_id", orderId)
    .in("id", openLines.map((line) => line.id));

  if (updateError) redirect(`/orders/${orderId}?error=${encodeURIComponent(updateError.message)}`);

  const orderColumns = await loadTableColumnSet(adminClient, "shipping_orders", ["review_status", "fulfillment_status"]);
  const orderPayload = filterPayloadByColumnSet({ review_status: "APPROVED", fulfillment_status: "PENDING" }, orderColumns);
  await adminClient.from("shipping_orders").update(orderPayload).eq("id", orderId);
  await recalculateProductQueues(openLines.map((line) => line.product_id).filter((productId): productId is string => Boolean(productId)));
  await writeOrderActivity(adminClient, orderId, "ORDER_MOVED_TO_WAREHOUSE", { line_count: openLines.length });

  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/inventory");
  redirect(`/orders/${orderId}?message=Order+moved+to+warehouse`);
}

export async function moveOrderLineBackToOrdersAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  const lineId = getString(formData, "lineId");
  const adminClient = getSupabaseAdmin();
  if (!orderId || !lineId) redirect(`/orders/${orderId ?? ""}?error=Missing+order+line+reference`);
  await assertOrderIsOperational(adminClient, orderId);

  const { data: line, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, warehouse_status, fulfillment_status, approved_qty, fulfilled_qty")
    .eq("id", lineId)
    .eq("shipping_order_id", orderId)
    .maybeSingle();

  if (lineError || !line) redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError?.message ?? "Order line not found")}`);

  if (Number(line.fulfilled_qty ?? 0) > 0 || ["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(String(line.fulfillment_status ?? "").toUpperCase())) {
    redirect(`/orders/${orderId}?error=Shipped+or+closed+items+cannot+be+moved+back+to+Orders`);
  }

  if (!["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase())) {
    redirect(`/orders/${orderId}?error=This+item+is+not+currently+in+the+warehouse+queue`);
  }

  const { error: updateError } = await adminClient
    .from("shipping_order_lines")
    .update({ approval_status: "APPROVED", warehouse_status: "ON_FLOOR", fulfillment_status: "PENDING" })
    .eq("id", lineId)
    .eq("shipping_order_id", orderId);

  if (updateError) redirect(`/orders/${orderId}?error=${encodeURIComponent(updateError.message)}`);

  if (line.product_id) await recalculateProductQueues([line.product_id]);
  await writeOrderActivity(adminClient, orderId, "ORDER_LINE_MOVED_BACK_TO_ORDERS", { line_id: lineId });

  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/inventory");
  redirect(`/orders/${orderId}?message=Item+moved+back+to+Orders`);
}

export async function moveOrderBackToOrdersAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  const adminClient = getSupabaseAdmin();
  if (!orderId) redirect("/orders?error=Missing+order+reference");
  await assertOrderIsOperational(adminClient, orderId);

  const { data: lines, error: linesError } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, warehouse_status, fulfillment_status, fulfilled_qty")
    .eq("shipping_order_id", orderId);
  if (linesError) redirect(`/orders/${orderId}?error=${encodeURIComponent(linesError.message)}`);

  const movableLines = (lines ?? []).filter((line) =>
    ["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"].includes(String(line.warehouse_status ?? "").toUpperCase())
    && Number(line.fulfilled_qty ?? 0) <= 0
    && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(String(line.fulfillment_status ?? "").toUpperCase()),
  );
  if (movableLines.length === 0) redirect(`/orders/${orderId}?error=No+open+warehouse+items+can+be+moved+back+to+Orders`);

  const { error: updateError } = await adminClient
    .from("shipping_order_lines")
    .update({ approval_status: "APPROVED", warehouse_status: "ON_FLOOR", fulfillment_status: "PENDING" })
    .eq("shipping_order_id", orderId)
    .in("id", movableLines.map((line) => line.id));
  if (updateError) redirect(`/orders/${orderId}?error=${encodeURIComponent(updateError.message)}`);

  await recalculateProductQueues(movableLines.map((line) => line.product_id).filter((productId): productId is string => Boolean(productId)));
  await writeOrderActivity(adminClient, orderId, "ORDER_MOVED_BACK_TO_ORDERS", { line_count: movableLines.length });
  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/inventory");
  redirect(`/orders/${orderId}?message=${encodeURIComponent(`${movableLines.length} item${movableLines.length === 1 ? "" : "s"} moved back to Orders`)}`);
}

/**
 * Re-entering an invoice refreshes the existing order from current QuickBooks data and activates it
 * as an operational order. Historical imports stay dormant until this happens, so entering an
 * invoice never creates a duplicate and never bulk-activates the rest of the backlog.
 */
async function activateExistingQuickbooksOrder(
  adminClient: ReturnType<typeof getSupabaseAdmin>,
  orderId: string,
  invoice: { id: string; qbo_invoice_id: string | null; invoice_number: string | null; raw_payload?: unknown },
) {
  await assertOrderIsOperational(adminClient, orderId);
  // The completed shipment is immutable evidence. Reconcile a stale summary
  // before planning the QBO refresh so that refresh sees this line as shipped
  // and can never re-open, requeue, or deduct it a second time.
  await reconcileConfirmedShipmentEvidenceForOrder(adminClient, orderId);
  const { data: importedInvoiceLines } = await adminClient
    .from("qbo_invoice_lines")
    .select("id, qbo_line_id, product_id, ordered_qty, qbo_sku, source_description")
    .eq("qbo_invoice_id", invoice.id);

  const rawLines = invoice.raw_payload && typeof invoice.raw_payload === "object" && Array.isArray((invoice.raw_payload as { Line?: unknown[] }).Line)
    ? (invoice.raw_payload as { Line: Array<Record<string, unknown>> }).Line
    : [];
  const currentQboLineIds = new Set(rawLines.map((line) => String(line.Id ?? "").trim()).filter(Boolean));
  const invoiceLines = currentQboLineIds.size > 0
    ? (importedInvoiceLines ?? []).filter((line) => currentQboLineIds.has(String(line.qbo_line_id ?? "")))
    : importedInvoiceLines ?? [];

  const { data: orderLines } = await adminClient
    .from("shipping_order_lines")
    .select("id, qbo_invoice_line_id, legacy_item_code, product_id, ordered_qty, approved_qty, fulfilled_qty, approval_status, warehouse_status, allocation_status, fulfillment_status")
    .eq("shipping_order_id", orderId);

  const aliasSkus = (invoiceLines ?? []).flatMap((line) => qboSkuCandidates(line.qbo_sku));
  const [{ data: productRows }, { data: aliasRows }] = await Promise.all([
    adminClient.from("products").select("id, sku"),
    aliasSkus.length
      ? adminClient.from("product_aliases").select("alias, product_id").in("alias", aliasSkus)
      : Promise.resolve({ data: [] as Array<{ alias: string | null; product_id: string }> }),
  ]);
  // Do not let an ambiguous alias silently select the last product returned.
  // Direct catalog SKUs win; aliases are accepted only when uniquely mapped.
  const productIdByAlias = buildSafeQboProductIdByAlias(productRows ?? [], aliasRows ?? []);

  const plan = planQuickbooksOrderRefresh(invoiceLines ?? [], orderLines ?? [], productIdByAlias);
  const existingLineById = new Map((orderLines ?? []).map((line) => [line.id, line]));
  for (const removal of plan.removals) {
    const { error: allocationError } = await adminClient.from("inventory_allocations").delete().eq("shipping_order_line_id", removal.lineId);
    if (allocationError) redirect(`/orders/${orderId}?error=${encodeURIComponent(allocationError.message)}`);
    const { error } = await adminClient.from("shipping_order_lines").update({
      approved_qty: 0,
      allocation_status: "UNALLOCATED",
      warehouse_status: "HOLD",
      fulfillment_status: "CANCELLED",
    }).eq("id", removal.lineId);
    if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);
  }
  for (const update of plan.updates) {
    const existing = existingLineById.get(update.lineId);
    const productChanged = Boolean(existing?.product_id && update.product_id && existing.product_id !== update.product_id);
    if (productChanged) {
      const { error: allocationError } = await adminClient.from("inventory_allocations").delete().eq("shipping_order_line_id", update.lineId);
      if (allocationError) redirect(`/orders/${orderId}?error=${encodeURIComponent(allocationError.message)}`);
    }
    // If a previous refresh incorrectly retired an unshipped line because its
    // QBO product mapping was temporarily unavailable, the live QBO line is
    // authoritative proof that the obligation remains active. Restore it to
    // the operational queue without touching fulfillment history.
    const shouldRestoreActiveLine = Number(existing?.fulfilled_qty ?? 0) <= 0
      && (
        String(existing?.fulfillment_status ?? "").toUpperCase() === "CANCELLED"
        || String(existing?.warehouse_status ?? "").toUpperCase() === "HOLD"
        || String(existing?.warehouse_status ?? "").toUpperCase() === "PENDING_REVIEW"
      );
    const { error } = await adminClient
      .from("shipping_order_lines")
      .update({
        ordered_qty: update.ordered_qty,
        approved_qty: update.approved_qty,
        approval_status: update.approval_status,
        product_id: update.product_id ?? undefined,
        ...(update.qboInvoiceLineId ? { qbo_invoice_line_id: update.qboInvoiceLineId } : {}),
        ...(productChanged ? { allocation_status: "UNALLOCATED", fulfillment_source: null } : {}),
        ...(shouldRestoreActiveLine ? { warehouse_status: "ON_FLOOR", fulfillment_status: "PENDING" } : {}),
      })
      .eq("id", update.lineId);
    if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);

    const invoiceLineId = update.qboInvoiceLineId ?? existing?.qbo_invoice_line_id;
    if (invoiceLineId && update.product_id) {
      await adminClient.from("qbo_invoice_lines").update({
        product_id: update.product_id,
        mapping_status: "MAPPED",
        approval_status: "APPROVED",
      }).eq("id", invoiceLineId);
    }
  }

  for (const insert of plan.inserts) {
    const { error } = await adminClient.from("shipping_order_lines").insert({
      shipping_order_id: orderId,
      qbo_invoice_line_id: insert.qboInvoiceLineId,
      product_id: insert.productId,
      ordered_qty: insert.orderedQty,
      approved_qty: insert.orderedQty,
      fulfilled_qty: 0,
      cancelled_qty: 0,
      approval_status: "APPROVED",
      warehouse_status: "ON_FLOOR",
      allocation_status: "UNALLOCATED",
      fulfillment_status: "PENDING",
      priority: "NORMAL",
      source_event_key: `QBO_INVOICE_LINE:${invoice.qbo_invoice_id}:${insert.qboLineId}`,
      legacy_item_code: insert.qboSku,
    });
    if (error && error.code !== "23505") redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);
  }

  await adminClient.from("shipping_orders").update({ review_status: "APPROVED" }).eq("id", orderId);
  await writeOrderActivity(adminClient, orderId, "ORDER_REFRESHED_FROM_QUICKBOOKS", {
    message: `Order refreshed from QuickBooks invoice ${invoice.invoice_number ?? ""} and activated`,
  });

  // Always rebuild every product touched by this active order. A QBO refresh
  // must leave every mapped, unfulfilled line on its Customer List, including
  // unchanged siblings that were not otherwise part of the refresh plan.
  const { data: activeOrderLines, error: activeOrderLinesError } = await adminClient
    .from("shipping_order_lines")
    .select("product_id")
    .eq("shipping_order_id", orderId)
    .not("product_id", "is", null);
  if (activeOrderLinesError) redirect(`/orders/${orderId}?error=${encodeURIComponent(activeOrderLinesError.message)}`);
  const queueProductIds = Array.from(new Set([
    ...plan.productIds,
    ...(activeOrderLines ?? []).map((line) => line.product_id).filter((productId): productId is string => Boolean(productId)),
  ]));
  if (queueProductIds.length > 0) await recalculateProductQueues(queueProductIds);
  // Queue positions are calculated from fresh data above. Expire the shared
  // Customer List projection too, otherwise this order can render its
  // pre-refresh "assignment pending" result until the cache naturally ages.
  // This is display/position invalidation only; it cannot alter stock,
  // allocations, fulfillment, or shipment records.
  revalidateCanonicalCustomerQueue();
  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/inventory");
}

export async function refreshOrderFromQuickbooksAction(formData: FormData) {
  await requireUser();
  const orderId = getString(formData, "orderId");
  if (!orderId) redirect("/orders?error=Missing+order+reference");

  const adminClient = getSupabaseAdmin();
  await assertOrderIsOperational(adminClient, orderId);
  const { data: order, error: orderError } = await adminClient
    .from("shipping_orders")
    .select("id,source_invoice_id")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError || !order?.source_invoice_id) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(orderError?.message ?? "This order is not linked to a QuickBooks invoice")}`);
  }

  const { data: invoiceBefore, error: invoiceBeforeError } = await adminClient
    .from("qbo_invoices")
    .select("id,qbo_invoice_id")
    .eq("id", order.source_invoice_id)
    .maybeSingle();
  if (invoiceBeforeError || !invoiceBefore?.qbo_invoice_id) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(invoiceBeforeError?.message ?? "QuickBooks invoice reference is missing")}`);
  }

  try {
    await syncQuickbooksInvoice(invoiceBefore.qbo_invoice_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "QuickBooks refresh failed";
    redirect(`/orders/${orderId}?error=${encodeURIComponent(message)}`);
  }

  const { data: refreshedInvoice, error: refreshedInvoiceError } = await adminClient
    .from("qbo_invoices")
    .select("id,qbo_invoice_id,invoice_number,raw_payload")
    .eq("id", order.source_invoice_id)
    .maybeSingle();
  if (refreshedInvoiceError || !refreshedInvoice) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(refreshedInvoiceError?.message ?? "Refreshed invoice could not be loaded")}`);
  }

  await activateExistingQuickbooksOrder(adminClient, orderId, refreshedInvoice);
  redirect(`/orders/${orderId}?message=${encodeURIComponent(`Invoice ${refreshedInvoice.invoice_number ?? ""} refreshed from live QuickBooks data`)}`);
}

export async function createOrderFromQuickbooksInvoiceAction(formData: FormData) {
  await requireUser();
  const invoiceId = getString(formData, "qbo_invoice_id");
  const paymentHold = getString(formData, "payment_hold") === "true";
  const adminClient = getSupabaseAdmin();
  if (!invoiceId) redirect("/orders/new?error=Select+a+QuickBooks+invoice");

  const [{ data: invoice, error: invoiceError }, { data: existing }] = await Promise.all([
    adminClient.from("qbo_invoices").select("id, qbo_invoice_id, invoice_number, customer_id, payment_status, invoice_date, total_amount, raw_payload").eq("id", invoiceId).maybeSingle(),
    adminClient.from("shipping_orders").select("id, review_status, source_type, source_system, created_at").eq("source_invoice_id", invoiceId).order("created_at", { ascending: true }),
  ]);

  if (invoiceError || !invoice) redirect(`/orders/new?error=${encodeURIComponent(invoiceError?.message ?? "QuickBooks invoice not found")}`);
  if (!isPaidQuickbooksInvoice(invoice.payment_status) && !paymentHold) {
    redirect(`/orders/new?error=Unpaid+invoices+must+be+explicitly+added+with+a+payment+hold`);
  }

  const existingOrder = resolveCanonicalOrderParent(existing ?? []);
  const resolution = resolveInvoiceOrder(existingOrder);
  if (resolution.action === "refresh") {
    if (paymentHold) {
      const { error: holdError } = await adminClient.from("shipping_orders").update({ payment_hold: true, payment_hold_reason: "Approved prepayment exception", payment_hold_set_at: new Date().toISOString() } as never).eq("id", resolution.orderId);
      if (holdError) redirect(`/orders/${resolution.orderId}?error=${encodeURIComponent(holdError.message)}`);
    }
    await activateExistingQuickbooksOrder(adminClient, resolution.orderId, invoice);
    redirect(`/orders?tab=new&message=QuickBooks+invoice+opened+in+New+Orders`);
  }

  const { data: customer } = invoice.customer_id
    ? await adminClient.from("customers").select("full_name, company_name").eq("id", invoice.customer_id).maybeSingle()
    : { data: null };
  const { data: invoiceLines, error: linesError } = await adminClient
    .from("qbo_invoice_lines")
    .select("id, qbo_invoice_id, qbo_line_id, product_id, ordered_qty, qbo_sku, source_description")
    .eq("qbo_invoice_id", invoiceId);

  if (linesError) redirect(`/orders/new?error=${encodeURIComponent(linesError.message)}`);
  if (!invoiceLines?.length) redirect(`/orders/new?error=This+invoice+has+no+imported+QuickBooks+lines`);

  const aliasSkus = invoiceLines.flatMap((line) => qboSkuCandidates(line.qbo_sku));
  const [{ data: productRows }, { data: aliasRows }] = await Promise.all([
    adminClient.from("products").select("id, sku"),
    aliasSkus.length
      ? adminClient.from("product_aliases").select("alias, product_id").in("alias", aliasSkus)
      : Promise.resolve({ data: [] as Array<{ alias: string | null; product_id: string }> }),
  ]);
  // Keep exact catalog identity ahead of aliases and fail safely on alias collisions.
  const productIdByAlias = buildSafeQboProductIdByAlias(productRows ?? [], aliasRows ?? []);

  const { data: order, error: orderError } = await adminClient
    .from("shipping_orders")
    .insert({
      customer_id: invoice.customer_id,
      source_invoice_id: invoice.id,
      order_number: invoice.invoice_number,
      source_type: "QBO_INVOICE",
      review_status: "APPROVED",
      legacy_customer_name: customer?.company_name ?? customer?.full_name ?? null,
      payment_hold: paymentHold,
      payment_hold_reason: paymentHold ? "Approved prepayment exception" : null,
      payment_hold_set_at: paymentHold ? new Date().toISOString() : null,
    } as never)
    .select("id")
    .single();

  if (orderError || !order?.id) redirect(`/orders/new?error=${encodeURIComponent(orderError?.message ?? "Unable to create order")}`);

  const mappedInvoiceLines = invoiceLines
    .map((line) => ({
      ...line,
      product_id: line.product_id
        ?? qboSkuCandidates(line.qbo_sku).map((candidate) => productIdByAlias.get(candidate)).find(Boolean)
        ?? null,
    }))
    .filter((line): line is typeof line & { product_id: string } => Boolean(line.product_id));
  const { error: lineError } = mappedInvoiceLines.length
    ? await adminClient.from("shipping_order_lines").insert(mappedInvoiceLines.map((line) => ({
    shipping_order_id: order.id,
    qbo_invoice_line_id: line.id,
    product_id: line.product_id,
    ordered_qty: line.ordered_qty,
    fulfilled_qty: 0,
    cancelled_qty: 0,
    approved_qty: line.ordered_qty,
    approval_status: "APPROVED",
    warehouse_status: "ON_FLOOR",
    allocation_status: "UNALLOCATED",
    fulfillment_status: "PENDING",
    priority: "NORMAL",
    source_event_key: `QBO_INVOICE_LINE:${invoice.qbo_invoice_id}:${line.qbo_line_id}`,
    legacy_item_code: line.qbo_sku,
    })))
    : { error: null };

  if (lineError) redirect(`/orders/new?error=${encodeURIComponent(lineError.message)}`);
  try {
    await recalculateProductQueues(mappedInvoiceLines.map((line) => line.product_id));
    revalidateOrdersList();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Order was created, but its queue could not be refreshed";
    redirect(`/orders/${order.id}?error=${encodeURIComponent(`Order created, but queue refresh failed: ${message}`)}`);
  }
  redirect(`/orders?tab=new&message=QuickBooks+invoice+added+to+New+Orders`);
}

export async function overrideProductQueuePositionAction(formData: FormData) {
  await requireUser();

  const lineId = getString(formData, "lineId");
  const rawPosition = Number(getString(formData, "queue_position") ?? 0);
  const reason = normalizeReasonForStorage(getString(formData, "queue_position_reason") ?? "");
  if (!lineId || !Number.isInteger(rawPosition) || rawPosition < 1 || !reason) {
    redirect("/orders?error=Queue+position+and+reason+are+required");
  }

  const adminClient = getSupabaseAdmin();
  const { data: line, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, shipping_order_id")
    .eq("id", lineId)
    .maybeSingle();
  if (lineError || !line?.product_id) {
    redirect(`/orders?error=${encodeURIComponent(lineError?.message ?? "Queue line not found")}`);
  }

  const overridePayload = {
    queue_position_override: rawPosition,
    queue_position_override_reason: reason,
    queue_position_override_at: new Date().toISOString(),
  } as never;

  const { error: updateError } = await adminClient
    .from("shipping_order_lines")
    .update(overridePayload)
    .eq("id", lineId);
  if (updateError) redirect(`/orders?error=${encodeURIComponent(updateError.message)}`);

  await recalculateProductQueues([line.product_id]);
  await writeOrderActivity(adminClient, line.shipping_order_id, "PRODUCT_QUEUE_POSITION_OVERRIDDEN", {
    line_id: lineId,
    requested_position: rawPosition,
    reason,
  });

  revalidateOrdersList();
  revalidatePath(`/orders/${line.shipping_order_id}`);
  revalidatePath("/inventory");
  redirect(`/orders/${line.shipping_order_id}?message=Product+queue+reordered`);
}

export async function updateOrderScheduleAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  const scheduleDate = getString(formData, "schedule_date");
  const shippingMethod = getString(formData, "shipping_method");
  const scheduleNotes = getString(formData, "schedule_notes");
  const adminClient = getSupabaseAdmin();

  if (!orderId) {
    redirect("/orders?error=Missing+order+reference");
  }
  await assertOrderIsOperational(adminClient, orderId);

  const payload: {
    promised_ship_date?: string | null;
    shipping_method?: string | null;
    notes?: string | null;
  } = {
    promised_ship_date: scheduleDate && scheduleDate.trim() ? scheduleDate.trim() : null,
    shipping_method: shippingMethod && shippingMethod.trim() ? shippingMethod.trim() : null,
    notes: scheduleNotes && scheduleNotes.trim() ? scheduleNotes.trim() : null,
  };

  const shippingOrderColumnSet = await loadTableColumnSet(adminClient, "shipping_orders", [
    "promised_ship_date",
    "shipping_method",
    "notes",
  ]);

  const compatiblePayload = filterPayloadByColumnSet(payload, shippingOrderColumnSet);

  if (Object.keys(compatiblePayload).length === 0) {
    redirect(`/orders/${orderId}?error=Schedule+fields+are+not+available+in+the+current+database+schema`);
  }

  const { error } = await adminClient
    .from("shipping_orders")
    .update(compatiblePayload)
    .eq("id", orderId);

  if (error) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);
  }

  await writeOrderActivity(adminClient, orderId, "ORDER_SCHEDULE_UPDATED", {
    promised_ship_date: payload.promised_ship_date ?? null,
    shipping_method: payload.shipping_method ?? null,
  });

  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Schedule+updated`);
}

export async function updateOrderFulfillmentMethodAction(formData: FormData) {
  await requireUser();
  const orderId = getString(formData, "orderId");
  const method = getString(formData, "fulfillment_method");
  if (!orderId || !["SHIP", "WILL_CALL"].includes(method ?? "")) redirect(`/orders/${orderId ?? ""}?error=Invalid+fulfillment+method`);
  const adminClient = getSupabaseAdmin();
  await assertOrderIsOperational(adminClient, orderId);
  const { error } = await adminClient.from("shipping_orders").update({ fulfillment_method: method } as never).eq("id", orderId);
  if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);
  await writeOrderActivity(adminClient, orderId, "ORDER_FULFILLMENT_METHOD_UPDATED", { fulfillment_method: method });
  revalidateOrdersList(); revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Fulfillment+method+updated`);
}

export async function updateOrderOperationsAction(formData: FormData) {
  await requireUser();
  const orderId = getString(formData, "orderId");
  const warehouseState = getString(formData, "warehouse_state");
  const fulfillmentMethod = getString(formData, "fulfillment_method");
  const adminClient = getSupabaseAdmin();
  if (!orderId || !["ORDERS", "IN_WAREHOUSE"].includes(warehouseState ?? "") || !["SHIP", "WILL_CALL"].includes(fulfillmentMethod ?? "")) {
    redirect(`/orders/${orderId ?? ""}?error=Invalid+order+operations+selection`);
  }
  await assertOrderIsOperational(adminClient, orderId);

  const { data: lines, error: linesError } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, warehouse_status, fulfillment_status, fulfilled_qty, approved_qty")
    .eq("shipping_order_id", orderId);
  if (linesError) redirect(`/orders/${orderId}?error=${encodeURIComponent(linesError.message)}`);

  const openLines = (lines ?? []).filter((line) =>
    Number(line.fulfilled_qty ?? 0) <= 0
    && Number(line.approved_qty ?? 0) > 0
    && !["FULFILLED", "CANCELLED", "REMOVED", "DENIED"].includes(String(line.fulfillment_status ?? "").toUpperCase()),
  );
  const targetStatuses = warehouseState === "IN_WAREHOUSE"
    ? { approval_status: "APPROVED", warehouse_status: "IN_WAREHOUSE", fulfillment_status: "PENDING" }
    : { approval_status: "APPROVED", warehouse_status: "ON_FLOOR", fulfillment_status: "PENDING" };
  const { error: lineUpdateError } = openLines.length
    ? await adminClient.from("shipping_order_lines").update(targetStatuses).eq("shipping_order_id", orderId).in("id", openLines.map((line) => line.id))
    : { error: null };
  if (lineUpdateError) redirect(`/orders/${orderId}?error=${encodeURIComponent(lineUpdateError.message)}`);

  const { error: methodError } = await adminClient.from("shipping_orders").update({ fulfillment_method: fulfillmentMethod } as never).eq("id", orderId);
  if (methodError) redirect(`/orders/${orderId}?error=${encodeURIComponent(methodError.message)}`);

  await writeOrderActivity(adminClient, orderId, "ORDER_OPERATIONS_UPDATED", { warehouse_state: warehouseState, fulfillment_method: fulfillmentMethod });
  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/inventory");
  redirect(`/orders/${orderId}?message=Order+operations+updated`);
}

export async function addOrderNoteAction(formData: FormData) {
  const user = await requireUser();
  const orderId = formData.get("orderId")?.toString();
  const lineId = formData.get("lineId")?.toString();
  const sku = formData.get("sku")?.toString();
  const message = formData.get("message")?.toString()?.trim();
  const adminClient = getSupabaseAdmin();

  if (!orderId || !message) {
    redirect(`/orders/${orderId ?? ""}?error=Note+text+is+required`);
  }

  const { data: accessUser } = isUuid(user.id)
    ? await adminClient.from("access_users").select("id").eq("id", user.id).maybeSingle()
    : { data: null };
  const savedAt = new Date().toISOString();
  const { error } = await adminClient.from("audit_log").insert({
    entity_type: "shipping_order",
    entity_id: orderId,
    action: "ORDER_NOTE_ADDED",
    actor_id: accessUser?.id ?? null,
    details: {
      message,
      note_text: message,
      author_name: user.fullName ?? "Unknown user",
      saved_at: savedAt,
      line_id: lineId ?? null,
      sku: sku ?? null,
    },
  });

  if (error) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(`Unable to save note: ${error.message}`)}`);
  }

  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}

/**
 * Repairs a legacy shipment-ledger row that has no actual shipment parent.
 * This is intentionally a compensating fulfillment event only: it does not
 * touch stock, allocations, shipment records, or order status.
 */
export async function restoreOrphanedFulfillmentToQueueAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "orderId");
  const lineId = getString(formData, "lineId");
  if (!orderId || !lineId) redirect(`/orders/${orderId ?? ""}?error=Order+line+not+found`);

  const adminClient = getSupabaseAdmin();
  await assertOrderIsOperational(adminClient, orderId);
  const { data: line, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id,shipping_order_id,product_id,fulfilled_qty")
    .eq("id", lineId)
    .maybeSingle();
  if (lineError || !line || line.shipping_order_id !== orderId) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError?.message ?? "Order line not found")}`);
  }
  if (Number(line.fulfilled_qty ?? 0) > 0) {
    redirect(`/orders/${orderId}?error=This+line+is+currently+recorded+as+shipped+and+cannot+be+restored+automatically`);
  }

  const [{ data: events, error: eventsError }, { data: shipments, error: shipmentsError }] = await Promise.all([
    adminClient
      .from("fulfillments")
      .select("id,fulfilled_qty,shipment_number,fulfillment_type,source_event_key")
      .eq("shipping_order_line_id", lineId),
    adminClient
      .from("order_shipments")
      .select("shipment_number")
      .eq("shipping_order_id", orderId),
  ]);
  if (eventsError || shipmentsError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(eventsError?.message ?? shipmentsError?.message ?? "Unable to inspect fulfillment history")}`);
  }
  const shipmentRows = (shipments ?? []) as unknown as Array<{ shipment_number: string | null }>;
  const shipmentNumbers = new Set(shipmentRows.map((shipment) => String(shipment.shipment_number ?? "").trim()).filter(Boolean));
  const orphanedEvents = (events ?? []).filter((event) => (
    Number(event.fulfilled_qty ?? 0) > 0
    && String(event.fulfillment_type ?? "SHIPMENT").toUpperCase() === "SHIPMENT"
    && !shipmentNumbers.has(String(event.shipment_number ?? "").trim())
    && !String(event.source_event_key ?? "").startsWith("QUEUE_REPAIR:ORPHANED_FULFILLMENT:")
  ));
  const orphanedQty = orphanedEvents.reduce((total, event) => total + Number(event.fulfilled_qty ?? 0), 0);
  if (orphanedQty <= 0) {
    redirect(`/orders/${orderId}?error=No+orphaned+shipment+ledger+entry+was+found+for+this+line`);
  }

  const actorId = await safeAccessUserId(adminClient, user.id);
  const { error: repairError } = await adminClient.from("fulfillments").insert({
    shipping_order_line_id: lineId,
    fulfilled_qty: -orphanedQty,
    fulfilled_at: new Date().toISOString(),
    reason: "Orphaned historical shipment ledger reversed; no shipment record exists",
    source_event_key: `QUEUE_REPAIR:ORPHANED_FULFILLMENT:${lineId}:${orphanedEvents.map((event) => event.id).join(",")}`,
    fulfillment_type: "SHIPMENT",
    actor_id: actorId,
  } as never);
  if (repairError) redirect(`/orders/${orderId}?error=${encodeURIComponent(repairError.message)}`);

  await recalculateProductQueues(line.product_id ? [line.product_id] : []);
  revalidateCanonicalCustomerQueue();
  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath(`/orders/${orderId}`);
  await writeOrderActivity(adminClient, orderId, "ORPHANED_FULFILLMENT_REVERSED", {
    line_id: lineId,
    reversed_quantity: orphanedQty,
    reason: "No matching order shipment exists",
  });
  redirect(`/orders/${orderId}?message=Orphaned+shipment+ledger+reversed%3B+line+returned+to+Customer+List`);
}

export async function remapOrderLineProductAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  const lineId = getString(formData, "lineId");
  const productId = getString(formData, "productId");
  const adminClient = getSupabaseAdmin();

  if (!orderId || !lineId || !productId) {
    redirect(`/orders/${orderId ?? ""}?error=Select+a+product+to+map`);
  }
  await assertOrderIsOperational(adminClient, orderId);

  const { data: line, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id, shipping_order_id, product_id, qbo_invoice_line_id, approval_status")
    .eq("id", lineId)
    .maybeSingle();

  const lineRow = line as {
    id: string;
    shipping_order_id: string;
    product_id: string | null;
    qbo_invoice_line_id: string | null;
    approval_status: string | null;
  } | null;
  if (lineError || !lineRow || lineRow.shipping_order_id !== orderId) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError?.message ?? "Order line not found")}`);
  }

  const { data: product, error: productError } = await adminClient
    .from("products")
    .select("id")
    .eq("id", productId)
    .maybeSingle();
  if (productError || !product) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(productError?.message ?? "Selected product was not found")}`);
  }

  // Some older imports have the right product on the operational line but
  // either lost its foreign-key link to the QBO invoice row or still point at
  // a QBO row that was replaced during a later refresh. Either disconnects
  // the line from the canonical Customer List. Repair only an exact, unique
  // SKU match on this invoice; ambiguous matches remain untouched for review.
  // This writes identity/approval metadata only — it never changes inventory,
  // allocations, fulfillment, shipments, or status.
  let linkedQboInvoiceLineId = lineRow.qbo_invoice_line_id;
  const mappedSku = getString(formData, "mappedSku")?.trim() || null;
  if (mappedSku) {
    const { data: orderParent, error: orderParentError } = await adminClient
      .from("shipping_orders")
      .select("source_invoice_id")
      .eq("id", orderId)
      .maybeSingle();
    if (orderParentError) redirect(`/orders/${orderId}?error=${encodeURIComponent(orderParentError.message)}`);

    if (orderParent?.source_invoice_id) {
      const [{ data: qboCandidates, error: qboCandidatesError }, { data: qboInvoice, error: qboInvoiceError }] = await Promise.all([
        adminClient
        .from("qbo_invoice_lines")
        .select("id,qbo_line_id,qbo_sku")
        .eq("qbo_invoice_id", orderParent.source_invoice_id),
        adminClient
          .from("qbo_invoices")
          .select("raw_payload")
          .eq("id", orderParent.source_invoice_id)
          .maybeSingle(),
      ]);
      if (qboCandidatesError) redirect(`/orders/${orderId}?error=${encodeURIComponent(qboCandidatesError.message)}`);
      if (qboInvoiceError) redirect(`/orders/${orderId}?error=${encodeURIComponent(qboInvoiceError.message)}`);

      const mappedSkuCandidates = new Set(qboSkuCandidates(mappedSku));
      const liveQuantities = liveQuickBooksLineQuantities(qboInvoice?.raw_payload as { Line?: unknown[] } | null | undefined);
      const exactCandidates = (qboCandidates ?? []).filter((candidate) => (
        (liveQuantities.size === 0 || liveQuantities.has(String(candidate.qbo_line_id ?? "")))
        &&
        qboSkuCandidates(candidate.qbo_sku).some((candidateSku) => mappedSkuCandidates.has(candidateSku))
      ));
      if (exactCandidates.length === 1) linkedQboInvoiceLineId = exactCandidates[0]!.id;
    }
  }

  if (lineRow.product_id === productId) {
    // Keep the linked QuickBooks line aligned even when the visible order line
    // was already mapped. QBO refreshes use that linked identity to rebuild
    // the canonical Customer List; leaving an old/deleted QBO product here
    // can strand a real open line as "Queue assignment pending". This is
    // strictly product identity and approval metadata—never stock,
    // allocations, fulfillment, shipment history, or order status.
    if (linkedQboInvoiceLineId) {
      const { error: qboMappingError } = await adminClient
        .from("qbo_invoice_lines")
        .update({ product_id: productId, mapping_status: "MAPPED", approval_status: "APPROVED" } as never)
        .eq("id", linkedQboInvoiceLineId);
      if (qboMappingError) redirect(`/orders/${orderId}?error=${encodeURIComponent(qboMappingError.message)}`);
    }
    if (linkedQboInvoiceLineId !== lineRow.qbo_invoice_line_id) {
      const { error: linkError } = await adminClient
        .from("shipping_order_lines")
        .update({ qbo_invoice_line_id: linkedQboInvoiceLineId, approval_status: "APPROVED" } as never)
        .eq("id", lineId);
      if (linkError) redirect(`/orders/${orderId}?error=${encodeURIComponent(linkError.message)}`);
    }
    // A legacy/imported line can already point at the right catalog product
    // while its approval flag is still PENDING_REVIEW.  Treating that as a
    // no-op strands a real item outside its Customer List even though there
    // is nothing left for an employee to choose.  Approving this exact,
    // already-selected product changes queue eligibility only; it does not
    // allocate, fulfill, ship, or move any inventory.
    if (String(lineRow.approval_status ?? "").toUpperCase() !== "APPROVED") {
      const { error: approvalError } = await adminClient
        .from("shipping_order_lines")
        .update({ approval_status: "APPROVED" } as never)
        .eq("id", lineId);
      if (approvalError) redirect(`/orders/${orderId}?error=${encodeURIComponent(approvalError.message)}`);

      if (linkedQboInvoiceLineId) {
        const { error: qboApprovalError } = await adminClient
          .from("qbo_invoice_lines")
          .update({ mapping_status: "MAPPED", approval_status: "APPROVED" } as never)
          .eq("id", linkedQboInvoiceLineId);
        if (qboApprovalError) redirect(`/orders/${orderId}?error=${encodeURIComponent(qboApprovalError.message)}`);
      }

      await recalculateProductQueues([productId]);
      revalidateCanonicalCustomerQueue();
      await writeOrderActivity(adminClient, orderId, "ORDER_LINE_MAPPING_APPROVED", {
        line_id: lineId,
        product_id: productId,
        reason: "Existing product mapping approved for Customer List eligibility",
      });
      revalidatePath("/inventory");
      revalidatePath("/order-queue");
      revalidatePath("/product-mappings");
      revalidatePath(`/orders/${orderId}`);
      redirect(`/orders/${orderId}?message=Existing+product+mapping+approved+and+added+to+the+Customer+List`);
    }
    // The mapping may already be correct after a QuickBooks refresh while the
    // shared projection is still stale. Rebuild and expire it on this safe
    // no-op retry so an operator can immediately recover the queue position.
    await recalculateProductQueues([productId]);
    revalidateCanonicalCustomerQueue();
    revalidatePath("/inventory");
    revalidatePath("/order-queue");
    revalidatePath("/product-mappings");
    revalidatePath(`/orders/${orderId}`);
    redirect(`/orders/${orderId}?message=Existing+product+mapping+queue+refreshed`);
  }

  const lineColumnSet = await loadTableColumnSet(adminClient, "shipping_order_lines", ["legacy_matched_item_code"]);
  // A new manual mapping is an approval of this exact QBO line as well as of
  // its operational representation.  Leaving either record in
  // PENDING_REVIEW made a successful selection look like "Needs mapping" on
  // the next load, and could strand a real customer outside the Customer
  // List.  This is identity/queue eligibility only: it never creates an
  // allocation, shipment, fulfillment, or inventory transaction.
  const payload = lineColumnSet.has("legacy_matched_item_code")
    ? { product_id: productId, legacy_matched_item_code: mappedSku, approval_status: "APPROVED", warehouse_status: "APPROVED" }
    : { product_id: productId, approval_status: "APPROVED", warehouse_status: "APPROVED" };

  const { error: updateError } = await adminClient
    .from("shipping_order_lines")
    .update(payload as never)
    .eq("id", lineId);
  if (updateError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(updateError.message)}`);
  }

  if (linkedQboInvoiceLineId) {
    const { error: qboMappingError } = await adminClient
      .from("qbo_invoice_lines")
      .update({ product_id: productId, mapping_status: "MAPPED", approval_status: "APPROVED", warehouse_status: "APPROVED" } as never)
      .eq("id", linkedQboInvoiceLineId);
    if (qboMappingError) {
      redirect(`/orders/${orderId}?error=${encodeURIComponent(qboMappingError.message)}`);
    }
  }

  if (lineRow.product_id) {
    await recalculateProductQueues([lineRow.product_id]);
  }
  await recalculateProductQueues([productId]);
  revalidateCanonicalCustomerQueue();

  await writeOrderActivity(adminClient, orderId, "ORDER_LINE_PRODUCT_REASSIGNED", {
    line_id: lineId,
    previous_product_id: lineRow.product_id,
    next_product_id: productId,
    mapped_sku: mappedSku,
  });

  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath("/product-mappings");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Product+mapping+updated+for+this+order+line`);
}

export async function updateOrderLineAssignmentAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  const lineId = getString(formData, "lineId");
  const source = (getString(formData, "assignment_source") ?? "UNASSIGNED").toUpperCase();
  const containerId = getString(formData, "assignment_container_id");
  const supplier = getString(formData, "fulfillment_supplier")?.trim() || null;
  const reference = getString(formData, "fulfillment_reference")?.trim() || null;
  const tracking = getString(formData, "fulfillment_tracking")?.trim() || null;
  const fulfillmentNotes = getString(formData, "fulfillment_notes")?.trim() || null;
  const requestedQty = getPositiveNumber(formData, "qty_assigned");
  const adminClient = getSupabaseAdmin();

  if (!orderId || !lineId) {
    redirect(`/orders/${orderId ?? ""}`);
  }
  await assertOrderIsOperational(adminClient, orderId);

  const normalizedSource = normalizeFulfillmentSource(source);
  const isContainerAssignment = source === "CONTAINER";
  if (!normalizedSource && !isContainerAssignment) redirect(`/orders/${orderId}?error=Choose+Warehouse,+Container,+Dropship,+or+Other`);
  if (normalizedSource === "OTHER" && !fulfillmentNotes) redirect(`/orders/${orderId}?error=Notes+are+required+for+Other+fulfillment`);
  if (normalizedSource === "DROPSHIP" && !supplier) redirect(`/orders/${orderId}?error=Supplier+is+required+for+Dropshipping`);
  if (isContainerAssignment && !containerId) redirect(`/orders/${orderId}?error=Select+a+container+for+Container+assignment`);

  const { data: line, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id, shipping_order_id, product_id, approved_qty, fulfilled_qty, fulfillment_source")
    .eq("id", lineId)
    .maybeSingle();

  const lineRow = line as {
    id: string;
    shipping_order_id: string;
    product_id: string;
    ordered_qty: number | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    fulfillment_source: string | null;
  } | null;

  if (lineError || !lineRow || lineRow.shipping_order_id !== orderId) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError?.message ?? "Order line not found")}`);
  }

  const remainingQty = Math.max(0, Number(lineRow.approved_qty ?? 0) - Number(lineRow.fulfilled_qty ?? 0));
  const assignedQty = (isContainerAssignment || shouldCreateWarehouseReservation(normalizedSource))
    ? Math.min(remainingQty, requestedQty > 0 ? requestedQty : remainingQty)
    : 0;

  if ((isContainerAssignment || shouldCreateWarehouseReservation(normalizedSource)) && assignedQty <= 0) {
    redirect(`/orders/${orderId}?error=Assigned+quantity+must+be+greater+than+zero`);
  }

  const { error: clearError } = await adminClient
    .from("inventory_allocations")
    .delete()
    .eq("shipping_order_line_id", lineRow.id);

  if (clearError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(clearError.message)}`);
  }

  const { error: sourceError } = await adminClient.from("shipping_order_lines").update({
    // Container allocation is still an internal physical pipeline source.
    fulfillment_source: isContainerAssignment ? "WAREHOUSE" : normalizedSource,
    fulfillment_supplier: normalizedSource === "DROPSHIP" ? supplier : null,
    fulfillment_reference: normalizedSource === "DROPSHIP" ? reference : null,
    fulfillment_tracking: normalizedSource === "DROPSHIP" ? tracking : null,
    fulfillment_notes: fulfillmentNotes,
  } as never).eq("id", lineRow.id);
  if (sourceError) redirect(`/orders/${orderId}?error=${encodeURIComponent(sourceError.message)}`);

  if (remainingQty > 0 && (isContainerAssignment || shouldCreateWarehouseReservation(normalizedSource))) {
      const { error: insertError } = await adminClient.from("inventory_allocations").insert({
        shipping_order_line_id: lineRow.id,
        product_id: lineRow.product_id,
        quantity: assignedQty,
        allocation_status: "ALLOCATED",
        source_type: isContainerAssignment ? "CONTAINER" : "FLOOR",
        container_id: isContainerAssignment ? containerId : null,
      });

      if (insertError) {
        redirect(`/orders/${orderId}?error=${encodeURIComponent(insertError.message)}`);
      }
  }

  const { error: statusError } = await adminClient
    .from("shipping_order_lines")
    .update({
      allocation_status: assignedQty > 0 && (isContainerAssignment || shouldCreateWarehouseReservation(normalizedSource)) ? "ALLOCATED" : "UNALLOCATED",
      warehouse_status: assignedQty > 0 && shouldCreateWarehouseReservation(normalizedSource)
        ? "READY_TO_SHIP"
        : assignedQty > 0 && isContainerAssignment
          ? "APPROVED"
        : "ON_FLOOR",
    })
    .eq("id", lineRow.id);

  if (statusError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(statusError.message)}`);
  }

  await writeOrderActivity(adminClient, orderId, "ORDER_LINE_ASSIGNMENT_UPDATED", {
    line_id: lineId,
    source: isContainerAssignment ? "CONTAINER" : normalizedSource,
    container_id: isContainerAssignment ? containerId : null,
    quantity: assignedQty,
  });

  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Assignment+updated`);
}

export async function completeNonWarehouseFulfillmentAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "orderId");
  const lineId = getString(formData, "lineId");
  const fulfilledDate = getString(formData, "fulfilled_date")?.trim();
  const quantity = getPositiveNumber(formData, "fulfill_qty");
  const supplier = getString(formData, "fulfillment_supplier")?.trim() || null;
  const reference = getString(formData, "fulfillment_reference")?.trim() || null;
  const tracking = getString(formData, "fulfillment_tracking")?.trim() || null;
  const notes = getString(formData, "fulfillment_notes")?.trim() || null;
  const adminClient = getSupabaseAdmin();
  const actorId = await safeAccessUserId(adminClient, user.id);

  if (!orderId || !lineId) redirect(`/orders/${orderId ?? ""}?error=Missing+line+reference`);
  await assertOrderCanShip(adminClient, orderId);
  if (!fulfilledDate) redirect(`/orders/${orderId}?error=Completion+date+is+required`);
  if (quantity <= 0) redirect(`/orders/${orderId}?error=Fulfillment+quantity+must+be+greater+than+zero`);

  const { data: line, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, approved_qty, fulfilled_qty, fulfillment_source, fulfillment_supplier, fulfillment_reference, fulfillment_tracking, fulfillment_notes")
    .eq("id", lineId)
    .eq("shipping_order_id", orderId)
    .maybeSingle();

  const lineRow = line as {
    id: string;
    product_id: string | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    fulfillment_source: string | null;
    fulfillment_supplier?: string | null;
    fulfillment_reference?: string | null;
    fulfillment_tracking?: string | null;
    fulfillment_notes?: string | null;
  } | null;

  if (lineError || !lineRow) redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError?.message ?? "Order line not found")}`);
  const source = String(lineRow.fulfillment_source ?? "").toUpperCase();
  if (source !== "DROPSHIP" && source !== "OTHER") redirect(`/orders/${orderId}?error=Select+Dropship+or+Other+before+using+this+completion`);

  const finalSupplier = supplier ?? lineRow.fulfillment_supplier ?? null;
  const finalReference = reference ?? lineRow.fulfillment_reference ?? null;
  const finalTracking = tracking ?? lineRow.fulfillment_tracking ?? null;
  const finalNotes = notes ?? lineRow.fulfillment_notes ?? null;
  if (source === "DROPSHIP" && !finalSupplier) redirect(`/orders/${orderId}?error=Supplier+is+required+for+Dropship+completion`);
  if (source === "OTHER" && !finalNotes) redirect(`/orders/${orderId}?error=Explanation+is+required+for+Other+completion`);

  const approvedQty = Number(lineRow.approved_qty ?? 0);
  const fulfilledQty = Number(lineRow.fulfilled_qty ?? 0);
  const remainingQty = Math.max(0, approvedQty - fulfilledQty);
  if (quantity > remainingQty) redirect(`/orders/${orderId}?error=Fulfillment+quantity+cannot+exceed+remaining+quantity`);

  const nextFulfilledQty = fulfilledQty + quantity;
  const isComplete = nextFulfilledQty >= approvedQty && approvedQty > 0;
  const fulfilledAtIso = `${fulfilledDate}T12:00:00.000Z`;
  const eventKey = `${source}:${Date.now()}:${lineId}`;

  const { error: clearError } = await adminClient.from("inventory_allocations").delete().eq("shipping_order_line_id", lineId);
  if (clearError) redirect(`/orders/${orderId}?error=${encodeURIComponent(clearError.message)}`);

  const { error: updateError } = await adminClient.from("shipping_order_lines").update({
    fulfilled_qty: nextFulfilledQty,
    fulfillment_status: isComplete ? "FULFILLED" : "PARTIALLY_FULFILLED",
    warehouse_status: isComplete ? "FULFILLED" : "PARTIALLY_FULFILLED",
    allocation_status: "UNALLOCATED",
    fulfillment_supplier: source === "DROPSHIP" ? finalSupplier : null,
    fulfillment_reference: source === "DROPSHIP" ? finalReference : null,
    fulfillment_tracking: source === "DROPSHIP" ? finalTracking : null,
    fulfillment_notes: finalNotes,
  } as never).eq("id", lineId);
  if (updateError) redirect(`/orders/${orderId}?error=${encodeURIComponent(updateError.message)}`);

  const fulfillmentColumns = await loadTableColumnSet(adminClient, "fulfillments", ["fulfillment_type"]);
  const { error: fulfillmentError } = await adminClient.from("fulfillments").insert({
    shipping_order_line_id: lineId,
    fulfilled_qty: quantity,
    fulfilled_at: fulfilledAtIso,
    shipment_number: source === "DROPSHIP" ? finalReference : null,
    carrier: source === "DROPSHIP" ? finalSupplier : null,
    tracking_number: source === "DROPSHIP" ? finalTracking : null,
    reason: source === "DROPSHIP" ? "Dropship fulfillment completed" : `Other fulfillment completed: ${finalNotes}`,
    source_event_key: eventKey,
    actor_id: actorId,
    ...(fulfillmentColumns.has("fulfillment_type") ? { fulfillment_type: source } : {}),
  } as never);
  if (fulfillmentError) redirect(`/orders/${orderId}?error=${encodeURIComponent(fulfillmentError.message)}`);

  await refreshCustomerQueuesAfterFulfillment([lineRow.product_id]);
  await writeOrderActivity(adminClient, orderId, source === "DROPSHIP" ? "ORDER_LINE_DROPSHIP_COMPLETED" : "ORDER_LINE_OTHER_FULFILLMENT_COMPLETED", {
    line_id: lineId,
    fulfillment_source: source,
    quantity,
    supplier: finalSupplier,
    reference: finalReference,
    tracking_number: finalTracking,
    note: finalNotes,
    fulfilled_at: fulfilledAtIso,
  });
  await syncQuickbooksFulfillmentMemo(adminClient, orderId, {
    eventKey: `shipment:${eventKey}`,
    message: source === "DROPSHIP" ? "Dropship fulfillment recorded in OCC" : "External fulfillment recorded in OCC",
    occurredAt: fulfilledAtIso,
  });
  await syncQuickbooksFullyShippedMemo(adminClient, orderId, fulfilledAtIso);

  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=${source === "DROPSHIP" ? "Dropship" : "Other+fulfillment"}+completed`);
}

export async function markOrderLineShippedAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  const lineId = getString(formData, "lineId");
  const trackingNumber = (getString(formData, "tracking_number") ?? "").trim();
  const shipmentDate = (getString(formData, "shipment_date") ?? "").trim();
  const carrier = (getString(formData, "carrier") ?? "").trim();
  const shipQty = getPositiveNumber(formData, "ship_qty");
  const adminClient = getSupabaseAdmin();

  if (orderId) {
    const canonicalOrderId = await resolveCanonicalSiblingOrderId(adminClient, orderId);
    if (canonicalOrderId) {
      redirect(`/orders/${canonicalOrderId}?error=Use+the+canonical+QuickBooks+order+for+shipment+completion`);
    }
  }

  if (!orderId || !lineId) {
    redirect(`/orders/${orderId ?? ""}?error=Missing+line+reference`);
  }
  await assertOrderCanShip(adminClient, orderId);

  if (!trackingNumber) {
    redirect(`/orders/${orderId}?error=Tracking+number+is+required+to+mark+as+shipped`);
  }

  if (!shipmentDate) {
    redirect(`/orders/${orderId}?error=Shipment+date+is+required+to+mark+as+shipped`);
  }

  if (shipQty <= 0) {
    redirect(`/orders/${orderId}?error=Ship+quantity+must+be+greater+than+zero`);
  }

  const { data: line, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, legacy_item_code, approved_qty, fulfilled_qty, fulfillment_source, products(sku,canonical_name)")
    .eq("id", lineId)
    .maybeSingle();

  const lineRow = line as {
    id: string;
    product_id: string | null;
    legacy_item_code?: string | null;
    products?: { sku?: string | null; canonical_name?: string | null } | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    fulfillment_source: string | null;
  } | null;

  if (lineError || !lineRow) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError?.message ?? "Order line not found")}`);
  }
  const approvedQty = Number(lineRow.approved_qty ?? 0);
  const fulfilledQty = Number(lineRow.fulfilled_qty ?? 0);
  const remainingQty = Math.max(0, approvedQty - fulfilledQty);

  if (shipQty > remainingQty) {
    redirect(`/orders/${orderId}?error=Ship+quantity+cannot+exceed+remaining+quantity`);
  }

  const nextFulfilledQty = fulfilledQty + shipQty;
  const isComplete = nextFulfilledQty >= approvedQty && approvedQty > 0;

  const { error: updateError } = await adminClient
    .from("shipping_order_lines")
    .update({
      fulfilled_qty: nextFulfilledQty,
      fulfillment_status: isComplete ? "FULFILLED" : "PARTIALLY_FULFILLED",
      warehouse_status: isComplete ? "FULFILLED" : "PARTIALLY_FULFILLED",
    })
    .eq("id", lineId);

  if (updateError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(updateError.message)}`);
  }

  const fulfilledAtIso = `${shipmentDate}T12:00:00.000Z`;
  const shipmentNumber = `SHIP-${Date.now()}`;

  const { error: fulfillmentInsertError } = await adminClient
    .from("fulfillments")
    .insert({
      shipping_order_line_id: lineId,
      fulfilled_qty: shipQty,
      fulfilled_at: fulfilledAtIso,
      shipment_number: shipmentNumber,
      carrier: carrier || null,
      tracking_number: trackingNumber,
      reason: "Order line marked shipped",
      source_event_key: crypto.randomUUID(),
      ...((await loadTableColumnSet(adminClient, "fulfillments", ["fulfillment_type"])).has("fulfillment_type") ? { fulfillment_type: "SHIPMENT" } : {}),
    } as never);

  if (fulfillmentInsertError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(fulfillmentInsertError.message)}`);
  }

  try {
    if (shouldMoveWarehouseInventory(lineRow.fulfillment_source ?? "WAREHOUSE")) {
      await recordFulfillmentInventory(adminClient, lineId, lineRow.product_id, shipQty, `SHIPMENT:${shipmentNumber}:${lineId}`);
    }
  } catch (inventoryError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(inventoryError instanceof Error ? inventoryError.message : "Unable to update inventory")}`);
  }

  try {
    await syncOrderSummaryState(adminClient, orderId, trackingNumber, carrier || null);
  } catch (orderUpdateError) {
    const message = orderUpdateError instanceof Error ? orderUpdateError.message : "Unable to update order summary state";
    redirect(`/orders/${orderId}?error=${encodeURIComponent(message)}`);
  }

  await writeOrderActivity(adminClient, orderId, "ORDER_LINE_SHIPPED", {
    line_id: lineId,
    ship_qty: shipQty,
    tracking_number: trackingNumber,
    carrier: carrier || null,
    shipment_date: shipmentDate,
  });
  await syncQuickbooksFulfillmentMemo(adminClient, orderId, {
    eventKey: `shipment:${shipmentNumber}`,
    message: `Shipment recorded in OCC${trackingNumber ? ` (tracking ${trackingNumber})` : ""}${describeShipmentItems([lineRow], () => shipQty)}`,
    occurredAt: fulfilledAtIso,
  });
  await syncQuickbooksFullyShippedMemo(adminClient, orderId, fulfilledAtIso);

  await refreshCustomerQueuesAfterFulfillment([lineRow.product_id]);
  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Shipment+recorded`);
}

export async function markOrderLinesPickedUpAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "orderId");
  const selectedIds = formData.getAll("line_id").map(String).filter(Boolean);
  const pickupPersonName = getString(formData, "pickup_person_name")?.trim();
  const acknowledgmentDocumentId = getString(formData, "acknowledgment_document_id");
  const driversLicenseDocumentId = getString(formData, "drivers_license_document_id");
  const pickupDate = getString(formData, "pickup_date")?.trim();
  const notes = getString(formData, "pickup_notes")?.trim() || null;
  const adminClient = getSupabaseAdmin();
  if (orderId) {
    const canonicalOrderId = await resolveCanonicalSiblingOrderId(adminClient, orderId);
    if (canonicalOrderId) {
      redirect(`/orders/${canonicalOrderId}?error=Use+the+canonical+QuickBooks+order+for+pickup+completion`);
    }
  }
  const actorId = await safeAccessUserId(adminClient, user.id);
  if (!orderId || selectedIds.length === 0 || !pickupPersonName || !acknowledgmentDocumentId || !driversLicenseDocumentId) redirect(`/orders/${orderId ?? ""}?error=Pickup+person,+acknowledgment,+driver%27s+license,+and+items+are+required`);
  await assertOrderCanShip(adminClient, orderId);

  const documentColumns = await loadTableColumnSet(adminClient, "order_attachments", ["document_type", "is_restricted"]);
  if (!documentColumns.has("document_type") || !documentColumns.has("is_restricted")) redirect(`/orders/${orderId}?error=Pickup+document+schema+is+not+available+yet`);
  const { data: rawDocuments, error: documentError } = await adminClient.from("order_attachments").select("id,document_type,is_restricted").eq("shipping_order_id", orderId).in("id", [acknowledgmentDocumentId, driversLicenseDocumentId]);
  const documents = rawDocuments as unknown as Array<{ id: string; document_type?: string | null; is_restricted?: boolean | null }> | null;
  if (documentError || documents?.length !== 2 || !documents.some((doc) => doc.id === acknowledgmentDocumentId && doc.document_type === "PICKUP_RECEIPT") || !documents.some((doc) => doc.id === driversLicenseDocumentId && doc.document_type === "DRIVERS_LICENSE" && doc.is_restricted)) redirect(`/orders/${orderId}?error=Required+pickup+documents+are+missing+or+not+restricted`);

  const { data: lines, error: lineError } = await adminClient.from("shipping_order_lines").select("id,product_id,approved_qty,fulfilled_qty,fulfillment_status,fulfillment_source").eq("shipping_order_id", orderId).in("id", selectedIds);
  if (lineError || lines?.length !== selectedIds.length) redirect(`/orders/${orderId}?error=Pickup+line+selection+is+invalid`);
  const pickupLines = (lines ?? []) as unknown as Array<{ id: string; product_id: string | null; approved_qty: number | null; fulfilled_qty: number | null; fulfillment_source?: string | null }>;
  const pickedAt = pickupDate ? `${pickupDate}T12:00:00.000Z` : new Date().toISOString();
  const pickupId = crypto.randomUUID();
  for (const line of pickupLines) {
    const pickupQty = getPositiveNumber(formData, `pickup_qty_${line.id}`);
    if (!shouldMoveWarehouseInventory(line.fulfillment_source ?? "WAREHOUSE")) redirect(`/orders/${orderId}?error=Dropship+and+Other+lines+must+use+their+own+completion+action`);
    const remaining = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
    if (pickupQty <= 0 || pickupQty > remaining) redirect(`/orders/${orderId}?error=Pickup+quantity+is+invalid`);
    const nextQty = Number(line.fulfilled_qty ?? 0) + pickupQty;
    const complete = nextQty >= Number(line.approved_qty ?? 0);
    const update = await adminClient.from("shipping_order_lines").update({ fulfilled_qty: nextQty, fulfillment_status: complete ? "FULFILLED" : "PARTIALLY_FULFILLED", warehouse_status: complete ? "FULFILLED" : "PARTIALLY_FULFILLED" }).eq("id", line.id);
    if (update.error) redirect(`/orders/${orderId}?error=${encodeURIComponent(update.error.message)}`);
    const event = await adminClient.from("fulfillments").insert({ shipping_order_line_id: line.id, fulfilled_qty: pickupQty, fulfilled_at: pickedAt, reason: "Order line picked up", source_event_key: `PICKUP:${pickupId}:${line.id}`, fulfillment_type: "PICKUP", actor_id: actorId } as never);
    if (event.error) redirect(`/orders/${orderId}?error=${encodeURIComponent(event.error.message)}`);
    try {
      await recordFulfillmentInventory(adminClient, line.id, line.product_id, pickupQty, `PICKUP:${pickupId}:${line.id}`, user.id);
    } catch (inventoryError) {
      redirect(`/orders/${orderId}?error=${encodeURIComponent(inventoryError instanceof Error ? inventoryError.message : "Unable to update inventory")}`);
    }
    if (line.product_id) await recalculateProductQueues([line.product_id]);
  }
  const pickupTable = adminClient.from("order_pickups") as any;
  const pickup = await pickupTable.insert({ id: pickupId, shipping_order_id: orderId, pickup_person_name: pickupPersonName, pickup_at: pickedAt, completed_by: user.id, notes, acknowledgment_document_id: acknowledgmentDocumentId, drivers_license_document_id: driversLicenseDocumentId });
  if (pickup.error) redirect(`/orders/${orderId}?error=${encodeURIComponent(pickup.error.message)}`);
  await writeOrderActivity(adminClient, orderId, "ORDER_PICKUP_COMPLETED", { pickup_id: pickupId, pickup_person_name: pickupPersonName, line_count: lines?.length ?? 0, notes });
  await syncQuickbooksFullyShippedMemo(adminClient, orderId, pickedAt);
  revalidateOrdersList(); revalidatePath("/inventory"); revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Pickup+completed`);
}

export async function shipSelectedOrderLinesAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  const trackingNumber = (getString(formData, "tracking_number") ?? "").trim();
  const shipmentDate = (getString(formData, "shipment_date") ?? "").trim();
  const carrier = (getString(formData, "carrier") ?? "").trim();
  const selectedIds = formData.getAll("line_id").map((value) => String(value).trim()).filter(Boolean);
  const adminClient = getSupabaseAdmin();
  if (orderId) {
    const canonicalOrderId = await resolveCanonicalSiblingOrderId(adminClient, orderId);
    if (canonicalOrderId) {
      redirect(`/orders/${canonicalOrderId}?error=Use+the+canonical+QuickBooks+order+for+shipment+completion`);
    }
  }

  if (!orderId) redirect(`/orders/${orderId ?? ""}?error=Select+at+least+one+mapped+item+to+ship`);
  await assertOrderCanShip(adminClient, orderId);
  if (selectedIds.length === 0) {
    const hasShippableLines = await hasRemainingShippableLinesForOrder(adminClient, orderId);
    if (!hasShippableLines) redirect(`/orders/${orderId}?error=${encodeURIComponent(NO_SHIPPABLE_LINES_ERROR)}`);
    redirect(`/orders/${orderId}?error=Select+at+least+one+mapped+item+to+ship`);
  }
  if (!trackingNumber) redirect(`/orders/${orderId}?error=Tracking+number+is+required`);
  if (!shipmentDate) redirect(`/orders/${orderId}?error=Shipment+date+is+required`);

  const { data: lines, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id, shipping_order_id, product_id, legacy_item_code, qbo_invoice_line_id, ordered_qty, approved_qty, fulfilled_qty, approval_status, fulfillment_status, fulfillment_source, products(sku,canonical_name)")
    .eq("shipping_order_id", orderId)
    .in("id", selectedIds);

  if (lineError) redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError.message)}`);

  const selectedLines = (lines ?? []) as unknown as Array<{
    id: string;
    shipping_order_id: string;
    product_id: string | null;
    qbo_invoice_line_id: string | null;
    ordered_qty: number | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    approval_status: string | null;
    fulfillment_status: string | null;
    fulfillment_source: string | null;
    legacy_item_code?: string | null;
    products?: { sku?: string | null; canonical_name?: string | null } | null;
  }>;

  if (selectedLines.length !== selectedIds.length) redirect(`/orders/${orderId}?error=Selected+line+does+not+belong+to+this+order`);
  if (selectedLines.some((line) => !line.product_id)) redirect(`/orders/${orderId}?error=Cannot+ship+an+unmapped+product+line`);
  if (selectedLines.some((line) => !shouldMoveWarehouseInventory(line.fulfillment_source ?? "WAREHOUSE"))) redirect(`/orders/${orderId}?error=Dropship+and+Other+lines+must+use+their+own+completion+action`);
  try {
    await assertLogicalFulfillmentCapacity(
      adminClient,
      selectedLines,
      new Map(selectedLines.map((line) => [line.id, Math.max(0, Math.max(Number(line.approved_qty ?? 0), Number(line.ordered_qty ?? 0)) - Number(line.fulfilled_qty ?? 0))])),
    );
  } catch (capacityError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(capacityError instanceof Error ? capacityError.message : "Unable to validate fulfillment capacity")}`);
  }

  const fulfilledAt = `${shipmentDate}T12:00:00.000Z`;
  const shipmentNumber = `SHIP-${Date.now()}`;
  const shipmentQuantityByLineId = new Map(selectedLines.map((line) => [
    line.id,
    Math.max(0, Math.max(Number(line.approved_qty ?? 0), Number(line.ordered_qty ?? 0)) - Number(line.fulfilled_qty ?? 0)),
  ]));
  for (const line of selectedLines) {
    const remaining = Math.max(0, Math.max(Number(line.approved_qty ?? 0), Number(line.ordered_qty ?? 0)) - Number(line.fulfilled_qty ?? 0));
    if (remaining <= 0) continue;
    const { error: updateError } = await adminClient.from("shipping_order_lines").update({
      fulfilled_qty: Number(line.fulfilled_qty ?? 0) + remaining,
      fulfillment_status: "FULFILLED",
      warehouse_status: "FULFILLED",
    }).eq("id", line.id);
    if (updateError) redirect(`/orders/${orderId}?error=${encodeURIComponent(updateError.message)}`);

    const { error: fulfillmentError } = await adminClient.from("fulfillments").insert({
      shipping_order_line_id: line.id,
      fulfilled_qty: remaining,
      fulfilled_at: fulfilledAt,
      shipment_number: shipmentNumber,
      carrier: carrier || null,
      tracking_number: trackingNumber,
      reason: "Selected items shipped",
      source_event_key: crypto.randomUUID(),
    });
    if (fulfillmentError) redirect(`/orders/${orderId}?error=${encodeURIComponent(fulfillmentError.message)}`);
    try {
      await recordFulfillmentInventory(adminClient, line.id, line.product_id, remaining, `SHIPMENT:${shipmentNumber}:${line.id}`);
    } catch (inventoryError) {
      redirect(`/orders/${orderId}?error=${encodeURIComponent(inventoryError instanceof Error ? inventoryError.message : "Unable to update inventory")}`);
    }
  }

  try {
    await syncOrderSummaryState(adminClient, orderId, trackingNumber, carrier || null);
  } catch (error) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(error instanceof Error ? error.message : "Unable to update order summary")}`);
  }

  await writeOrderActivity(adminClient, orderId, "ORDER_ITEMS_SHIPPED", {
    line_ids: selectedIds.join(","),
    line_count: selectedIds.length,
    tracking_number: trackingNumber,
    carrier: carrier || null,
    shipment_date: shipmentDate,
  });
  await syncQuickbooksFulfillmentMemo(adminClient, orderId, {
    eventKey: `shipment:${shipmentNumber}`,
    message: `Shipment recorded in OCC${trackingNumber ? ` (tracking ${trackingNumber})` : ""}${describeShipmentItems(selectedLines, (line) => shipmentQuantityByLineId.get(line.id) ?? 0)}`,
    occurredAt: fulfilledAt,
  });
  await syncQuickbooksFullyShippedMemo(adminClient, orderId, fulfilledAt);

  await refreshCustomerQueuesAfterFulfillment(selectedLines.map((line) => line.product_id));
  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=${encodeURIComponent(`${selectedLines.length} item${selectedLines.length === 1 ? "" : "s"} shipped`)}`);
}

export async function completeOrderShipmentAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "orderId");
  const shipmentDate = getString(formData, "shipment_date");
  const idempotencyKey = getString(formData, "idempotency_key");
  const carrier = getString(formData, "carrier");
  const trackingNumber = getString(formData, "tracking_number");
  const notes = getString(formData, "shipment_notes");
  const selectedIds = formData.getAll("selected_line_id").map(String).filter(Boolean);
  const adminClient = getSupabaseAdmin();
  if (orderId) {
    const canonicalOrderId = await resolveCanonicalSiblingOrderId(adminClient, orderId);
    if (canonicalOrderId) {
      redirect(`/orders/${canonicalOrderId}?error=Use+the+canonical+QuickBooks+order+for+shipment+completion`);
    }
  }
  if (!orderId || !shipmentDate || !idempotencyKey) redirect(`/orders/${orderId ?? ""}?error=Select+shipment+items+and+a+ship+date`);
  await assertOrderCanShip(adminClient, orderId);
  if (selectedIds.length === 0) {
    const hasShippableLines = await hasRemainingShippableLinesForOrder(adminClient, orderId);
    if (!hasShippableLines) redirect(`/orders/${orderId}?error=${encodeURIComponent(NO_SHIPPABLE_LINES_ERROR)}`);
    redirect(`/orders/${orderId}?error=Select+shipment+items+and+a+ship+date`);
  }

  const lines = selectedIds.map((lineId) => ({ line_id: lineId, quantity: getPositiveNumber(formData, `quantity_${lineId}`) }));
  if (lines.some((line) => line.quantity <= 0)) redirect(`/orders/${orderId}?error=Shipment+quantities+must+be+greater+than+zero`);
  const { data: sourceRows, error: sourceError } = await adminClient
    .from("shipping_order_lines")
    .select("id,shipping_order_id,product_id,legacy_item_code,qbo_invoice_line_id,ordered_qty,approved_qty,fulfilled_qty,fulfillment_source,products(sku,canonical_name)")
    .eq("shipping_order_id", orderId)
    .in("id", selectedIds);
  if (sourceError || sourceRows?.length !== selectedIds.length) redirect(`/orders/${orderId}?error=${encodeURIComponent(sourceError?.message ?? "Selected+line+does+not+belong+to+this+order")}`);
  const shipmentSourceRows = (sourceRows ?? []) as unknown as Array<FulfillmentCapacityLine & ShipmentMemoLine & { fulfillment_source?: string | null }>;
  if (shipmentSourceRows.some((line) => !shouldMoveWarehouseInventory(line.fulfillment_source ?? "WAREHOUSE"))) redirect(`/orders/${orderId}?error=Dropship+and+Other+lines+must+use+their+own+completion+action`);
  try {
    await assertLogicalFulfillmentCapacity(adminClient, shipmentSourceRows, new Map(lines.map((line) => [line.line_id, line.quantity])));
  } catch (capacityError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(capacityError instanceof Error ? capacityError.message : "Unable to validate fulfillment capacity")}`);
  }

  const { data: shipmentId, error } = await adminClient.rpc("complete_order_shipment", {
    p_order_id: orderId,
    p_shipped_at: `${shipmentDate}T12:00:00.000Z`,
    p_carrier: carrier || null,
    p_tracking_number: trackingNumber || null,
    p_notes: notes || null,
    p_idempotency_key: idempotencyKey,
    p_lines: lines,
  } as never);
  if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);
  const { error: shipmentNoteError } = await adminClient
    .from("order_shipments")
    .update({ notes: notes?.trim() || null } as never)
    .eq("id", shipmentId)
    .eq("shipping_order_id", orderId);
  if (shipmentNoteError) redirect(`/orders/${orderId}?error=${encodeURIComponent(shipmentNoteError.message)}`);
  await writeOrderActivity(adminClient, orderId, "ORDER_SHIPMENT_COMPLETED", { shipment_id: shipmentId, line_count: selectedIds.length, tracking_number: trackingNumber || null });
  await syncQuickbooksFulfillmentMemo(adminClient, orderId, {
    eventKey: `shipment:${shipmentId}`,
    message: `Shipment created in OCC${trackingNumber ? ` (tracking ${trackingNumber})` : ""}${describeShipmentItems(shipmentSourceRows, (line) => lines.find((selected) => selected.line_id === line.id)?.quantity ?? 0)}`,
    occurredAt: `${shipmentDate}T12:00:00.000Z`,
  });
  await syncQuickbooksFullyShippedMemo(adminClient, orderId, `${shipmentDate}T12:00:00.000Z`);
  await refreshCustomerQueuesAfterFulfillment(shipmentSourceRows.map((line) => line.product_id));
  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Shipment+completed`);
}

/**
 * Safe, manual backfill for one existing OCC shipment. It writes only the
 * linked QBO invoice's PrivateNote, allowing staff to confirm the memo format
 * on a historical shipment without re-running fulfillment or stock logic.
 */
export async function syncOrderShipmentMemoAction(formData: FormData) {
  await requireUser();
  const orderId = getString(formData, "orderId");
  const shipmentId = getString(formData, "shipment_id");
  const adminClient = getSupabaseAdmin();
  if (!orderId || !shipmentId) redirect(`/orders/${orderId ?? ""}?error=Missing+shipment+reference`);

  const { data: shipmentRow, error } = await adminClient
    .from("order_shipments")
    .select("id,shipment_number,shipped_at,tracking_number,lines:order_shipment_lines(quantity,shipping_order_lines(legacy_item_code,products(sku,canonical_name)))")
    .eq("id", shipmentId)
    .eq("shipping_order_id", orderId)
    .maybeSingle();
  const shipment = shipmentRow as unknown as {
    id: string;
    shipment_number: string;
    shipped_at: string;
    tracking_number: string | null;
    lines?: Array<{ quantity: number | null; shipping_order_lines?: ShipmentMemoLine | null }>;
  } | null;
  if (error || !shipment) redirect(`/orders/${orderId}?error=${encodeURIComponent(error?.message ?? "Shipment not found")}`);

  const shipmentLines = (shipment.lines ?? [])
    .map((line) => ({ ...(line.shipping_order_lines ?? { id: "" }), quantity: Number(line.quantity ?? 0) }))
    .filter((line) => line.id);
  const shipmentQuantityByLineId = new Map(shipmentLines.map((line) => [line.id, line.quantity]));
  const result = await appendQuickbooksInternalMemoForOrder(orderId, {
    eventKey: `shipment:${shipment.id}`,
    message: `Shipment created in OCC${shipment.tracking_number ? ` (tracking ${shipment.tracking_number})` : ""}${describeShipmentItems(shipmentLines, (line) => shipmentQuantityByLineId.get(line.id) ?? 0)}`,
    occurredAt: shipment.shipped_at,
  });
  await writeOrderActivity(adminClient, orderId, "QBO_INTERNAL_MEMO_SYNCED", {
    event_key: `shipment:${shipment.id}`,
    result: result.status,
    qbo_invoice_id: "qboInvoiceId" in result ? result.qboInvoiceId ?? null : null,
    manual_backfill: true,
  });
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=QuickBooks+shipment+memo+synced`);
}

export async function completeSelectedFulfillmentAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "orderId");
  const fulfillmentDate = getString(formData, "shipment_date");
  const idempotencyKey = getString(formData, "idempotency_key");
  const carrier = getString(formData, "carrier");
  const trackingNumber = getString(formData, "tracking_number");
  const reference = getString(formData, "fulfillment_reference")?.trim() || null;
  const notes = getString(formData, "shipment_notes")?.trim() || null;
  const selectedIds = formData.getAll("selected_line_id").map(String).filter(Boolean);
  const adminClient = getSupabaseAdmin();
  if (selectedIds.length === 0) redirect(`/orders/${orderId ?? ""}?error=Select+at+least+one+remaining+line`);
  if (!orderId) redirect(`/orders/?error=Select+fulfillment+items+and+a+date`);
  await assertOrderIsOperational(adminClient, orderId);
  const ownerOrderIdByLineId = new Map(selectedIds.map((lineId) => [lineId, getString(formData, `owner_order_id_${lineId}`) ?? orderId]));
  const fulfillmentOrderIds = Array.from(new Set(ownerOrderIdByLineId.values()));
  for (const fulfillmentOrderId of fulfillmentOrderIds) {
    await assertOrderCanShip(adminClient, fulfillmentOrderId);
  }
  {
    const { data: parentRows, error: parentError } = await adminClient
      .from("shipping_orders")
      .select("id,source_invoice_id,duplicate_of_order_id")
      .in("id", [orderId, ...fulfillmentOrderIds]);
    const typedParentRows = (parentRows ?? []) as unknown as Array<{ id: string; source_invoice_id: string | null; duplicate_of_order_id?: string | null }>;
    if (parentError || fulfillmentOrderIds.some((ownerOrderId) => !isActiveSameInvoiceSiblingOwner(orderId, ownerOrderId, typedParentRows))) {
      redirect(`/orders/${orderId}?error=Selected+fulfillment+line+does+not+belong+to+an+active+sibling+parent`);
    }
  }
  const actorId = await safeAccessUserId(adminClient, user.id);

  if (!fulfillmentDate || !idempotencyKey) redirect(`/orders/${orderId}?error=Select+fulfillment+items+and+a+date`);

  const selectedQuantities = new Map(selectedIds.map((lineId) => [lineId, getPositiveNumber(formData, `quantity_${lineId}`)]));
  if ([...selectedQuantities.values()].some((quantity) => quantity <= 0)) redirect(`/orders/${orderId}?error=Fulfillment+quantities+must+be+greater+than+zero`);

  const { data: rows, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id, shipping_order_id, product_id, legacy_item_code, qbo_invoice_line_id, ordered_qty, approved_qty, fulfilled_qty, fulfillment_status, fulfillment_source, fulfillment_supplier, fulfillment_reference, fulfillment_tracking, fulfillment_notes, products(sku,canonical_name)")
    .in("id", selectedIds);
  if (lineError || rows?.length !== selectedIds.length) redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError?.message ?? "Selected+line+does+not+belong+to+this+order")}`);

  const lines = (rows ?? []) as unknown as Array<{ id: string; shipping_order_id: string; product_id: string | null; legacy_item_code?: string | null; qbo_invoice_line_id: string | null; ordered_qty: number | null; approved_qty: number | null; fulfilled_qty: number | null; fulfillment_status: string | null; fulfillment_source: string | null; fulfillment_supplier?: string | null; fulfillment_reference?: string | null; fulfillment_tracking?: string | null; fulfillment_notes?: string | null; products?: { sku?: string | null; canonical_name?: string | null } | null }>;
  if (lines.some((line) => ownerOrderIdByLineId.get(line.id) !== line.shipping_order_id)) redirect(`/orders/${orderId}?error=Selected+line+owner+does+not+match+its+operational+record`);
  if (lines.some((line) => !line.product_id)) redirect(`/orders/${orderId}?error=Cannot+fulfill+an+unmapped+product+line`);
  try {
    await assertLogicalFulfillmentCapacity(adminClient, lines, selectedQuantities);
  } catch (capacityError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(capacityError instanceof Error ? capacityError.message : "Unable to validate fulfillment capacity")}`);
  }

  const fulfilledAtIso = `${fulfillmentDate}T12:00:00.000Z`;
  const linesByOwner = new Map<string, typeof lines>();
  for (const line of lines) {
    const ownerLines = linesByOwner.get(line.shipping_order_id) ?? [];
    ownerLines.push(line);
    linesByOwner.set(line.shipping_order_id, ownerLines);
  }
  for (const line of lines.filter((candidate) => !shouldMoveWarehouseInventory(candidate.fulfillment_source ?? "WAREHOUSE"))) {
    const source = String(line.fulfillment_source ?? "").toUpperCase();
    if (source !== "DROPSHIP" && source !== "OTHER") redirect(`/orders/${orderId}?error=Dropship+and+Other+must+be+assigned+before+non-warehouse+completion`);
    const quantity = selectedQuantities.get(line.id) ?? 0;
    const approvedQty = Math.max(Number(line.approved_qty ?? 0), Number(line.ordered_qty ?? 0));
    const fulfilledQty = Number(line.fulfilled_qty ?? 0);
    const remaining = Math.max(0, approvedQty - fulfilledQty);
    if (quantity > remaining) redirect(`/orders/${orderId}?error=Fulfillment+quantity+cannot+exceed+remaining+quantity`);
    const nextFulfilled = fulfilledQty + quantity;
    const isComplete = nextFulfilled >= approvedQty && approvedQty > 0;
    const finalNotes = notes || line.fulfillment_notes || (source === "DROPSHIP" ? "Dropship fulfillment completed" : null);
    if (source === "OTHER" && !finalNotes) redirect(`/orders/${orderId}?error=Explanation+is+required+for+Other+completion`);
    if (source === "DROPSHIP" && !line.fulfillment_supplier && !carrier) redirect(`/orders/${orderId}?error=Supplier+is+required+for+Dropship+completion`);

    const { error: updateError } = await adminClient.from("shipping_order_lines").update({
      fulfillment_supplier: source === "DROPSHIP" ? (line.fulfillment_supplier || carrier || null) : null,
      fulfillment_reference: source === "DROPSHIP" ? (line.fulfillment_reference || reference || null) : null,
      fulfillment_tracking: source === "DROPSHIP" ? (line.fulfillment_tracking || trackingNumber || null) : null,
      fulfillment_notes: finalNotes,
    } as never).eq("id", line.id);
    if (updateError) redirect(`/orders/${orderId}?error=${encodeURIComponent(updateError.message)}`);
  }

  for (const [fulfillmentOrderId, ownerLines] of linesByOwner) {
    const { data: createdShipmentId, error } = await adminClient.rpc("complete_order_shipment", {
      p_order_id: fulfillmentOrderId,
      p_shipped_at: fulfilledAtIso,
      p_carrier: carrier || null,
      p_tracking_number: trackingNumber || null,
      p_notes: notes,
      p_idempotency_key: `${idempotencyKey}:FULFILLMENT:${fulfillmentOrderId}`,
      p_lines: ownerLines.map((line) => ({ line_id: line.id, quantity: selectedQuantities.get(line.id) ?? 0 })),
    } as never);
    if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);
    if (!createdShipmentId) redirect(`/orders/${orderId}?error=Unable+to+create+shipment+record`);
    const shipmentId = createdShipmentId as string;
    const { error: shipmentNoteError } = await adminClient.from("order_shipments").update({ notes } as never).eq("id", shipmentId).eq("shipping_order_id", fulfillmentOrderId);
    if (shipmentNoteError) redirect(`/orders/${orderId}?error=${encodeURIComponent(shipmentNoteError.message)}`);
    const warehouseCount = ownerLines.filter((line) => shouldMoveWarehouseInventory(line.fulfillment_source ?? "WAREHOUSE")).length;
    await writeOrderActivity(adminClient, fulfillmentOrderId, "ORDER_SELECTED_FULFILLMENT_COMPLETED", { line_ids: ownerLines.map((line) => line.id).join(","), warehouse_count: warehouseCount, non_warehouse_count: ownerLines.length - warehouseCount, fulfilled_at: fulfilledAtIso });
    await syncQuickbooksFulfillmentMemo(adminClient, fulfillmentOrderId, {
      eventKey: `shipment:${shipmentId}`,
      message: `Shipment created in OCC${trackingNumber ? ` (tracking ${trackingNumber})` : ""}${describeShipmentItems(ownerLines, (line) => selectedQuantities.get(line.id) ?? 0)}`,
      occurredAt: fulfilledAtIso,
    });
    await syncQuickbooksFullyShippedMemo(adminClient, fulfillmentOrderId, fulfilledAtIso);
  }
  await refreshCustomerQueuesAfterFulfillment(lines.map((line) => line.product_id));
  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  for (const fulfillmentOrderId of fulfillmentOrderIds) if (fulfillmentOrderId !== orderId) revalidatePath(`/orders/${fulfillmentOrderId}`);
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Fulfillment+completed`);
}

export async function editOrderShipmentAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "orderId");
  const shipmentId = getString(formData, "shipment_id");
  const shipmentDate = getString(formData, "shipment_date");
  const carrier = getString(formData, "carrier");
  const trackingNumber = getString(formData, "tracking_number");
  const notes = getString(formData, "shipment_notes");
  const selectedIds = formData.getAll("selected_line_id").map(String).filter(Boolean);
  const adminClient = getSupabaseAdmin();

  if (!orderId || !shipmentId || !shipmentDate) redirect(`/orders/${orderId ?? ""}?error=Shipment+and+ship+date+are+required`);
  await assertOrderIsOperational(adminClient, orderId);

  // Editing one shipment can add a line, remove a line, or change a quantity.
  // Rebuild every product queue on this order afterward so completed demand is
  // removed and restored demand re-enters exactly once.
  const { data: orderLineRows, error: orderLineError } = await adminClient
    .from("shipping_order_lines")
    .select("product_id")
    .eq("shipping_order_id", orderId);
  if (orderLineError) redirect(`/orders/${orderId}?error=${encodeURIComponent(orderLineError.message)}`);

  const lines = selectedIds.map((lineId) => ({ line_id: lineId, quantity: getPositiveNumber(formData, `quantity_${lineId}`) }));
  if (lines.some((line) => line.quantity <= 0)) redirect(`/orders/${orderId}?error=Shipment+quantities+must+be+greater+than+zero`);

  const { data: editedShipmentId, error } = await adminClient.rpc("edit_order_shipment", {
    p_shipment_id: shipmentId,
    p_order_id: orderId,
    p_shipped_at: `${shipmentDate}T12:00:00.000Z`,
    p_carrier: carrier || null,
    p_tracking_number: trackingNumber || null,
    p_notes: notes || null,
    p_actor_id: null,
    p_lines: lines,
  } as never);
  if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);

  await refreshCustomerQueuesAfterFulfillment(
    ((orderLineRows ?? []) as Array<{ product_id: string | null }>).map((line) => line.product_id),
  );

  await writeOrderActivity(adminClient, orderId, "ORDER_SHIPMENT_EDITED", {
    shipment_id: editedShipmentId ?? shipmentId,
    line_count: selectedIds.length,
    message: `Shipment edited by ${user.fullName ?? "employee"}`,
  });
  await syncQuickbooksFullyShippedMemo(adminClient, orderId, `${shipmentDate}T12:00:00.000Z`);
  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Shipment+updated#shipments`);
}

export async function updateOrderShipmentAction(formData: FormData) {
  await requireUser();
  const orderId = getString(formData, "orderId");
  const shipmentId = getString(formData, "shipment_id");
  const shipmentDate = getString(formData, "shipment_date");
  const carrier = getString(formData, "carrier");
  const trackingNumber = getString(formData, "tracking_number");
  const notes = getString(formData, "shipment_notes");
  const adminClient = getSupabaseAdmin();

  if (!orderId || !shipmentId) redirect(`/orders/${orderId ?? ""}?error=Missing+shipment+reference`);

  const payload: Record<string, string | null> = {
    carrier: carrier?.trim() || null,
    tracking_number: trackingNumber?.trim() || null,
    notes: notes?.trim() || null,
  };
  if (shipmentDate) payload.shipped_at = `${shipmentDate}T12:00:00.000Z`;

  const { error } = await adminClient
    .from("order_shipments")
    .update(payload as never)
    .eq("id", shipmentId)
    .eq("shipping_order_id", orderId);
  if (error) redirect(`/orders/${orderId}?error=${encodeURIComponent(error.message)}`);

  await writeOrderActivity(adminClient, orderId, "ORDER_SHIPMENT_UPDATED", {
    shipment_id: shipmentId,
    tracking_number: payload.tracking_number,
  });

  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Shipment+updated#shipments`);
}

/** Adds a line that was missed when the shipment was created, keeping stock and history in step. */
export async function addOrderShipmentLineAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "orderId");
  const shipmentId = getString(formData, "shipment_id");
  const lineId = getString(formData, "line_id");
  const quantity = getPositiveNumber(formData, "quantity");
  const adminClient = getSupabaseAdmin();

  if (!orderId || !shipmentId || !lineId) redirect(`/orders/${orderId ?? ""}?error=Select+an+item+to+add`);
  await assertOrderIsOperational(adminClient, orderId);
  if (quantity <= 0) redirect(`/orders/${orderId}?error=Quantity+must+be+greater+than+zero`);

  const { data: shipmentRow } = await adminClient
    .from("order_shipments")
    .select("id, shipment_number, shipped_at, carrier, tracking_number")
    .eq("id", shipmentId)
    .eq("shipping_order_id", orderId)
    .maybeSingle();
  const shipment = shipmentRow as unknown as {
    id: string;
    shipment_number: string;
    shipped_at: string;
    carrier: string | null;
    tracking_number: string | null;
  } | null;
  if (!shipment) redirect(`/orders/${orderId}?error=Shipment+not+found`);

  const { data: line } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, approved_qty, fulfilled_qty, fulfillment_source")
    .eq("id", lineId)
    .eq("shipping_order_id", orderId)
    .maybeSingle();
  const lineRow = line as unknown as { id: string; product_id: string | null; approved_qty: number | null; fulfilled_qty: number | null; fulfillment_source?: string | null } | null;
  if (!lineRow) redirect(`/orders/${orderId}?error=That+item+does+not+belong+to+this+order`);
  if (!shouldMoveWarehouseInventory(lineRow.fulfillment_source ?? "WAREHOUSE")) redirect(`/orders/${orderId}?error=Dropship+and+Other+lines+must+use+their+own+completion+action`);

  const alreadyFulfilled = Number(lineRow.fulfilled_qty ?? 0);
  const approved = Number(lineRow.approved_qty ?? 0);
  const nextFulfilled = alreadyFulfilled + quantity;
  if (nextFulfilled > approved) redirect(`/orders/${orderId}?error=Quantity+exceeds+the+remaining+amount`);

  const sourceEventKey = `ORDER_SHIPMENT_EDIT:${shipmentId}:${lineId}`;
  const { error: shipmentLineError } = await adminClient
    .from("order_shipment_lines")
    .insert({ shipment_id: shipmentId, shipping_order_line_id: lineId, quantity } as never);
  if (shipmentLineError) redirect(`/orders/${orderId}?error=${encodeURIComponent(shipmentLineError.message)}`);

  const { error: lineError } = await adminClient
    .from("shipping_order_lines")
    .update({
      fulfilled_qty: nextFulfilled,
      fulfillment_status: nextFulfilled >= approved ? "FULFILLED" : "PARTIALLY_FULFILLED",
      warehouse_status: nextFulfilled >= approved ? "FULFILLED" : "PARTIALLY_FULFILLED",
    })
    .eq("id", lineId);
  if (lineError) redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError.message)}`);

  await adminClient.from("fulfillments").insert({
    shipping_order_line_id: lineId,
    fulfilled_qty: quantity,
    fulfilled_at: shipment.shipped_at,
    shipment_number: shipment.shipment_number,
    carrier: shipment.carrier,
    tracking_number: shipment.tracking_number,
    reason: "Item added to existing shipment",
    source_event_key: sourceEventKey,
    fulfillment_type: "SHIPMENT",
  } as never);

  await recordFulfillmentInventory(adminClient, lineId, lineRow.product_id, quantity, sourceEventKey, user.id);
  await refreshCustomerQueuesAfterFulfillment([lineRow.product_id]);

  await writeOrderActivity(adminClient, orderId, "ORDER_SHIPMENT_LINE_ADDED", {
    shipment_id: shipmentId,
    line_id: lineId,
    ship_qty: quantity,
  });
  await syncQuickbooksFullyShippedMemo(adminClient, orderId, shipment.shipped_at);

  revalidateOrdersList();
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Item+added+to+shipment#shipments`);
}

export async function uploadOrderAttachmentAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "order_id");
  const files = formData.getAll("attachments").filter((item): item is File => item instanceof File && item.size > 0);
  const documentType = getString(formData, "document_type")?.trim() || "OTHER";
  const documentNote = getString(formData, "document_note")?.trim() || null;
  const shipmentId = getString(formData, "shipment_id");
  const adminClient = getSupabaseAdmin();
  const { data: accessUser } = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.id)
    ? await adminClient.from("access_users").select("id").eq("id", user.id).maybeSingle()
    : { data: null };

  if (!orderId || files.length === 0) {
    redirect(`/orders/${orderId ?? ""}`);
  }

  for (const file of files) {
    if (!isAllowedAttachment(file)) {
      redirect(`/orders/${orderId}?error=${encodeURIComponent("Unsupported file type. Use JPG, PNG, HEIC, PDF, or MP4")}`);
    }
  }

  for (const file of files) {
    const fileExtension = getFileExtension(file.name) || "bin";
    const safeFileName = `${Date.now()}-${crypto.randomUUID()}.${fileExtension}`;
    const storagePath = `${orderId}/${safeFileName}`;

    const { error: uploadError } = await adminClient.storage
      .from("case-attachments")
      .upload(storagePath, file, {
        cacheControl: "3600",
        upsert: false,
        contentType: file.type || undefined,
      });

    if (uploadError) {
      redirect(`/orders/${orderId}?error=${encodeURIComponent(uploadError.message)}`);
    }

    const attachmentPayload = {
      shipping_order_id: orderId,
      file_path: storagePath,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type || null,
      uploaded_by: accessUser?.id ?? null,
      ...((await loadTableColumnSet(adminClient, "order_attachments", ["document_type"])).has("document_type") ? { document_type: documentType } : {}),
      ...((await loadTableColumnSet(adminClient, "order_attachments", ["note"])).has("note") ? { note: documentNote } : {}),
      ...((await loadTableColumnSet(adminClient, "order_attachments", ["is_restricted"])).has("is_restricted") ? { is_restricted: documentType === "DRIVERS_LICENSE" } : {}),
      ...((shipmentId && (await loadTableColumnSet(adminClient, "order_attachments", ["shipment_id"])).has("shipment_id")) ? { shipment_id: shipmentId } : {}),
    } as never;
    const { error: dbError } = await adminClient.from("order_attachments").insert(attachmentPayload);

    if (dbError) redirect(`/orders/${orderId}?error=${encodeURIComponent(`Unable to save document metadata: ${dbError.message}`)}`);
  }

  await adminClient.from("audit_log").insert({
    entity_type: "shipping_order",
    entity_id: orderId,
    action: "ORDER_ATTACHMENT_UPLOADED",
    details: { file_count: files.length },
  });

  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}

export async function deleteOrderAttachmentAction(formData: FormData) {
  const orderId = getString(formData, "order_id");
  const attachmentId = getString(formData, "attachment_id");
  const deleteIntent = getString(formData, "delete_intent");
  const adminClient = getSupabaseAdmin();

  if (!orderId || !attachmentId || deleteIntent !== "DELETE_ATTACHMENT") {
    redirect(`/orders/${orderId ?? ""}`);
  }

  const { data: attachment, error: lookupError } = await adminClient
    .from("order_attachments")
    .select("id, file_name, file_path")
    .eq("id", attachmentId)
    .eq("shipping_order_id", orderId)
    .maybeSingle();

  const attachmentRow = attachment as { id: string; file_name: string; file_path: string } | null;

  if (lookupError || !attachmentRow) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(lookupError?.message ?? "Attachment not found")}`);
  }

  await adminClient.storage.from("case-attachments").remove([attachmentRow.file_path]);

  const { error: deleteError } = await adminClient
    .from("order_attachments")
    .delete()
    .eq("id", attachmentId)
    .eq("shipping_order_id", orderId);

  if (deleteError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(deleteError.message)}`);
  }

  await adminClient.from("audit_log").insert({
    entity_type: "shipping_order",
    entity_id: orderId,
    action: "ORDER_ATTACHMENT_DELETED",
    details: { file_name: attachmentRow.file_name },
  });

  revalidateOrdersList();
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}

export async function updateDeniedArchiveReasonAction(formData: FormData) {
  await requireUser();

  const rollupId = getString(formData, "rollup_id");
  const nextReasonRaw = getString(formData, "canonical_reason");
  const returnPath = getString(formData, "return_path") ?? "/orders?tab=denied";
  const adminClient = getSupabaseAdmin();

  if (!rollupId || !nextReasonRaw) {
    redirect(`${returnPath}${returnPath.includes("?") ? "&" : "?"}error=Missing+archive+edit+payload`);
  }

  const nextReason = normalizeReasonForStorage(nextReasonRaw);
  if (!nextReason) {
    redirect(`${returnPath}${returnPath.includes("?") ? "&" : "?"}error=Reason+cannot+be+empty`);
  }

  const { data: rollupRow, error: rollupLookupError } = await adminClient
    .from("order_history_reason_rollups")
    .select("id, reason_category, invoice_number_normalized, item_code_normalized, reason_normalized")
    .eq("id", rollupId)
    .maybeSingle();

  const rollup = rollupRow as {
    id: string;
    reason_category: string;
    invoice_number_normalized: string;
    item_code_normalized: string;
    reason_normalized: string;
  } | null;

  if (rollupLookupError || !rollup) {
    redirect(`${returnPath}${returnPath.includes("?") ? "&" : "?"}error=${encodeURIComponent(rollupLookupError?.message ?? "Denied archive row not found")}`);
  }

  const { error: rollupUpdateError } = await adminClient
    .from("order_history_reason_rollups")
    .update({ canonical_reason: nextReason } as never)
    .eq("id", rollup.id);

  if (rollupUpdateError) {
    redirect(`${returnPath}${returnPath.includes("?") ? "&" : "?"}error=${encodeURIComponent(rollupUpdateError.message)}`);
  }

  const { error: rawUpdateError } = await adminClient
    .from("order_history_reason_events_raw")
    .update({ reason: nextReason } as never)
    .eq("reason_category", rollup.reason_category)
    .eq("invoice_number_normalized", rollup.invoice_number_normalized)
    .eq("item_code_normalized", rollup.item_code_normalized)
    .eq("reason_normalized", rollup.reason_normalized);

  if (rawUpdateError) {
    redirect(`${returnPath}${returnPath.includes("?") ? "&" : "?"}error=${encodeURIComponent(rawUpdateError.message)}`);
  }

  revalidateOrdersList();
  revalidatePath("/order-archive");
  redirect(`${returnPath}${returnPath.includes("?") ? "&" : "?"}message=Denied+invoice+reason+updated`);
}
