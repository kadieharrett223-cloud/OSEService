"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

type AuditDetails = Record<string, string | number | boolean | null>;

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "pdf", "mp4"]);

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

function getFileExtension(fileName: string) {
  if (!fileName.includes(".")) return "";
  return fileName.split(".").pop()?.toLowerCase() ?? "";
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
      auditDetails = { action, approval_status: "APPROVED" };
      break;
    case "queue":
      payload.warehouse_status = "IN_WAREHOUSE";
      auditAction = "ORDER_LINE_QUEUED";
      auditDetails = { action, warehouse_status: "IN_WAREHOUSE" };
      break;
    case "fulfill":
      payload.fulfillment_status = "FULFILLED";
      payload.warehouse_status = "FULFILLED";
      auditAction = "ORDER_LINE_FULFILLED";
      auditDetails = { action, fulfillment_status: "FULFILLED" };
      break;
    case "hold":
      payload.approval_status = "HOLD";
      payload.warehouse_status = "HOLD";
      auditAction = "ORDER_LINE_HOLD";
      auditDetails = { action, approval_status: "HOLD" };
      break;
    default:
      break;
  }

  const { error } = await adminClient.from("shipping_order_lines").update(payload).eq("id", lineId);

  if (!error) {
    await writeOrderActivity(adminClient, orderId, auditAction, auditDetails);
  }

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
}

export async function addOrderNoteAction(formData: FormData) {
  const orderId = formData.get("orderId")?.toString();
  const message = formData.get("message")?.toString()?.trim();
  const adminClient = getSupabaseAdmin();

  if (!orderId || !message) {
    redirect(`/orders/${orderId ?? ""}`);
  }

  await adminClient.from("audit_log").insert({
    entity_type: "shipping_order",
    entity_id: orderId,
    action: "ORDER_NOTE_ADDED",
    details: { message },
  });

  revalidatePath("/orders");
  revalidatePath(`/orders/${orderId}`);
  redirect(`/orders/${orderId}`);
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
