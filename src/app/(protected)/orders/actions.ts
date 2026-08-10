"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

type AuditDetails = Record<string, string | number | boolean | null>;

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
