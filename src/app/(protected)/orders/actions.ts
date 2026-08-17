"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { recalculateProductQueues } from "@/lib/product-queue";

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

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

function getPositiveNumber(formData: FormData, key: string) {
  const raw = Number(getString(formData, key) ?? "0");
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
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
  const lineId = formData.get("lineId")?.toString();
  const orderId = formData.get("orderId")?.toString();
  const action = formData.get("action")?.toString();
  const adminClient = getSupabaseAdmin();

  if (!lineId || !orderId || !action) {
    redirect(`/orders/${orderId ?? ""}`);
  }

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
      payload.fulfillment_status = "FULFILLED";
      payload.warehouse_status = "FULFILLED";
      auditAction = "ORDER_LINE_FULFILLED";
      auditDetails = { action, line_id: lineId, fulfillment_status: "FULFILLED" };
      break;
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

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}

export async function acceptNewOrderAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  if (!orderId) {
    redirect("/orders?error=Missing+order+reference");
  }

  const adminClient = getSupabaseAdmin();
  const { data: lines, error: linesError } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, ordered_qty, approval_status, fulfillment_status")
    .eq("shipping_order_id", orderId);

  if (linesError) {
    redirect(`/orders?error=${encodeURIComponent(linesError.message)}`);
  }

  const pendingLines = (lines ?? []).filter((line) => line.approval_status === "PENDING_REVIEW");
  if (pendingLines.length === 0) {
    redirect("/orders?message=Order+has+no+pending+review+lines");
  }

  for (const line of pendingLines) {
    const { error: lineUpdateError } = await adminClient
      .from("shipping_order_lines")
      .update({
        approved_qty: Number(line.ordered_qty ?? 0),
        approval_status: "APPROVED",
        warehouse_status: "READY_TO_SHIP",
        fulfillment_status: "PENDING",
        approved_at: new Date().toISOString(),
      })
      .eq("id", line.id);

    if (lineUpdateError) {
      redirect(`/orders?error=${encodeURIComponent(lineUpdateError.message)}`);
    }
  }

  const { error: orderUpdateError } = await adminClient
    .from("shipping_orders")
    .update({
      review_status: "APPROVED",
      fulfillment_status: "PENDING",
    })
    .eq("id", orderId);

  if (orderUpdateError) {
    redirect(`/orders?error=${encodeURIComponent(orderUpdateError.message)}`);
  }

  await recalculateProductQueues(pendingLines.map((line) => line.product_id).filter((productId): productId is string => Boolean(productId)));

  await writeOrderActivity(adminClient, orderId, "ORDER_ACCEPTED", {
    action: "accept_order",
    accepted_line_count: pendingLines.length,
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  revalidatePath("/shipping-review");
  revalidatePath("/order-queue");
  revalidatePath("/inventory");
  redirect("/orders?message=Order+accepted");
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

  revalidatePath("/orders");
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

  revalidatePath("/schedule");
  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Schedule+updated`);
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

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}

export async function updateOrderLineAssignmentAction(formData: FormData) {
  await requireUser();

  const orderId = getString(formData, "orderId");
  const lineId = getString(formData, "lineId");
  const source = (getString(formData, "assignment_source") ?? "UNASSIGNED").toUpperCase();
  const containerId = getString(formData, "container_id");
  const requestedQty = getPositiveNumber(formData, "qty_assigned");
  const adminClient = getSupabaseAdmin();

  if (!orderId || !lineId) {
    redirect(`/orders/${orderId ?? ""}`);
  }

  const { data: line, error: lineError } = await adminClient
    .from("shipping_order_lines")
    .select("id, product_id, approved_qty, fulfilled_qty")
    .eq("id", lineId)
    .maybeSingle();

  const lineRow = line as {
    id: string;
    product_id: string;
    approved_qty: number | null;
    fulfilled_qty: number | null;
  } | null;

  if (lineError || !lineRow) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(lineError?.message ?? "Order line not found")}`);
  }
  
    await recalculateProductQueues([lineRow.product_id]);

  const remainingQty = Math.max(0, Number(lineRow.approved_qty ?? 0) - Number(lineRow.fulfilled_qty ?? 0));
  const assignedQty = source === "UNASSIGNED"
    ? 0
    : Math.min(remainingQty, requestedQty > 0 ? requestedQty : remainingQty);

  if (source !== "UNASSIGNED" && assignedQty <= 0) {
    redirect(`/orders/${orderId}?error=Assigned+quantity+must+be+greater+than+zero`);
  }

  const { error: clearError } = await adminClient
    .from("inventory_allocations")
    .delete()
    .eq("shipping_order_line_id", lineRow.id);

  if (clearError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(clearError.message)}`);
  }

  if (remainingQty > 0 && source !== "UNASSIGNED") {
    if (source === "CONTAINER") {
      if (!containerId) {
        redirect(`/orders/${orderId}?error=Container+selection+required`);
      }

      const { error: insertError } = await adminClient.from("inventory_allocations").insert({
        shipping_order_line_id: lineRow.id,
        product_id: lineRow.product_id,
        quantity: assignedQty,
        allocation_status: "ALLOCATED",
        source_type: "CONTAINER",
        container_id: containerId,
      });

      if (insertError) {
        redirect(`/orders/${orderId}?error=${encodeURIComponent(insertError.message)}`);
      }
    }

    if (source === "FLOOR") {
      const { error: insertError } = await adminClient.from("inventory_allocations").insert({
        shipping_order_line_id: lineRow.id,
        product_id: lineRow.product_id,
        quantity: assignedQty,
        allocation_status: "ALLOCATED",
        source_type: "FLOOR",
        container_id: null,
      });

      if (insertError) {
        redirect(`/orders/${orderId}?error=${encodeURIComponent(insertError.message)}`);
      }
    }
  }

  const { error: statusError } = await adminClient
    .from("shipping_order_lines")
    .update({
      allocation_status: assignedQty > 0 && source !== "UNASSIGNED" ? "ALLOCATED" : "UNALLOCATED",
    })
    .eq("id", lineRow.id);

  if (statusError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(statusError.message)}`);
  }

  await writeOrderActivity(adminClient, orderId, "ORDER_LINE_ASSIGNMENT_UPDATED", {
    line_id: lineId,
    source,
    container_id: source === "CONTAINER" ? (containerId ?? null) : null,
    quantity: assignedQty,
  });

  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Assignment+updated`);
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

  if (!orderId || !lineId) {
    redirect(`/orders/${orderId ?? ""}?error=Missing+line+reference`);
  }

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
    .select("id, product_id, approved_qty, fulfilled_qty")
    .eq("id", lineId)
    .maybeSingle();

  const lineRow = line as {
    id: string;
    product_id: string | null;
    approved_qty: number | null;
    fulfilled_qty: number | null;
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

  if (lineRow.product_id) await recalculateProductQueues([lineRow.product_id]);

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
    });

  if (fulfillmentInsertError) {
    redirect(`/orders/${orderId}?error=${encodeURIComponent(fulfillmentInsertError.message)}`);
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

  revalidatePath("/orders");
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
  revalidatePath("/schedule");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}?message=Shipment+recorded`);
}

export async function uploadOrderAttachmentAction(formData: FormData) {
  const user = await requireUser();
  const orderId = getString(formData, "order_id");
  const files = formData.getAll("attachments").filter((item): item is File => item instanceof File && item.size > 0);
  const adminClient = getSupabaseAdmin();

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

    const { error: dbError } = await adminClient.from("order_attachments").insert({
      shipping_order_id: orderId,
      file_path: storagePath,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type || null,
      uploaded_by: user.id,
    } as never);

    if (dbError) {
      redirect(`/orders/${orderId}?error=${encodeURIComponent(dbError.message)}`);
    }
  }

  await adminClient.from("audit_log").insert({
    entity_type: "shipping_order",
    entity_id: orderId,
    action: "ORDER_ATTACHMENT_UPLOADED",
    details: { file_count: files.length },
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}

export async function deleteOrderAttachmentAction(formData: FormData) {
  const orderId = getString(formData, "order_id");
  const attachmentId = getString(formData, "attachment_id");
  const adminClient = getSupabaseAdmin();

  if (!orderId || !attachmentId) {
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

  revalidatePath("/orders");
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

  revalidatePath("/orders");
  revalidatePath("/order-archive");
  redirect(`${returnPath}${returnPath.includes("?") ? "&" : "?"}message=Denied+invoice+reason+updated`);
}
