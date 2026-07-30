"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES, type CaseStatus } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

function getString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function getNullableString(formData: FormData, key: string) {
  const value = getString(formData, key);
  return value || null;
}

async function getCaseOrRedirect(caseId: string) {
  const supabase = getSupabaseAdmin();
  const { data: existingCase } = await supabase
    .from("customer_service_cases")
    .select("id, case_number")
    .eq("id", caseId)
    .maybeSingle();

  if (!existingCase) {
    redirect("/cases?error=case_not_found");
  }

  return { supabase, existingCase };
}

export async function updateCaseStatusAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const newStatus = getString(formData, "status");

  if (!caseId || !CASE_STATUSES.includes(newStatus as (typeof CASE_STATUSES)[number])) {
    redirect("/cases?error=invalid_status_update");
  }

  const validatedStatus = newStatus as CaseStatus;

  const { supabase, existingCase } = await getCaseOrRedirect(caseId);

  const updates: Database["public"]["Tables"]["customer_service_cases"]["Update"] = {
    status: validatedStatus,
  };
  if (newStatus === "Closed") {
    updates.closed_at = new Date().toISOString();
  }

  const { error } = await supabase
    .from("customer_service_cases")
    .update(updates as never)
    .eq("id", caseId);

  if (error) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
  }

  await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: user.id,
    activity_type: "status_changed",
    summary: `Status changed to ${newStatus}`,
    details: { case_number: existingCase.case_number, status: newStatus },
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath("/dashboard");
}

export async function addNoteAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const noteType = getString(formData, "note_type") === "customer" ? "customer" : "internal";
  const content = getString(formData, "content");

  if (!caseId || !content) {
    redirect(`/cases/${caseId || ""}?error=missing_note_content`);
  }

  const { supabase } = await getCaseOrRedirect(caseId);

  const { error } = await supabase.from("case_notes").insert({
    case_id: caseId,
    note_type: noteType,
    content,
    created_by: user.id,
  });

  if (error) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
  }

  await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: user.id,
    activity_type: "note_added",
    summary: `${noteType === "customer" ? "Customer-facing" : "Internal"} note added`,
  });

  revalidatePath(`/cases/${caseId}`);
}

export async function addReplacementPartAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const partName = getString(formData, "part_name");

  if (!caseId || !partName) {
    redirect(`/cases/${caseId || ""}?error=missing_part_name`);
  }

  const { supabase } = await getCaseOrRedirect(caseId);

  const quantityRaw = Number(getString(formData, "quantity") || "1");
  const quantity = Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : 1;

  const { error } = await supabase.from("replacement_parts").insert({
    case_id: caseId,
    part_name: partName,
    sku: getNullableString(formData, "sku"),
    quantity,
    product_model: getNullableString(formData, "product_model"),
    supplier: getNullableString(formData, "supplier"),
    cost: Number(getString(formData, "cost") || "0") || null,
    order_date: getNullableString(formData, "order_date"),
    ordered_by: user.id,
    shipping_status: getNullableString(formData, "shipping_status"),
    carrier: getNullableString(formData, "carrier"),
    tracking_number: getNullableString(formData, "tracking_number"),
    ship_date: getNullableString(formData, "ship_date"),
    delivery_date: getNullableString(formData, "delivery_date"),
    notes: getNullableString(formData, "notes"),
  });

  if (error) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
  }

  await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: user.id,
    activity_type: "replacement_part_added",
    summary: `Replacement part added: ${partName}`,
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/dashboard");
}

export async function uploadAttachmentAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const file = formData.get("attachment");

  if (!caseId || !(file instanceof File) || file.size <= 0) {
    redirect(`/cases/${caseId || ""}?error=attachment_missing`);
  }

  const { supabase } = await getCaseOrRedirect(caseId);

  const fileExtension = file.name.includes(".") ? file.name.split(".").pop() : "bin";
  const safeFileName = `${Date.now()}-${crypto.randomUUID()}.${fileExtension}`;
  const storagePath = `${caseId}/${safeFileName}`;

  const { error: uploadError } = await supabase.storage
    .from("case-attachments")
    .upload(storagePath, file, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type || undefined,
    });

  if (uploadError) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(uploadError.message)}`);
  }

  const { error: dbError } = await supabase.from("case_attachments").insert({
    case_id: caseId,
    file_path: storagePath,
    file_name: file.name,
    file_size: file.size,
    mime_type: file.type || null,
    uploaded_by: user.id,
  });

  if (dbError) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(dbError.message)}`);
  }

  await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: user.id,
    activity_type: "file_uploaded",
    summary: `Attachment uploaded: ${file.name}`,
  });

  revalidatePath(`/cases/${caseId}`);
}
