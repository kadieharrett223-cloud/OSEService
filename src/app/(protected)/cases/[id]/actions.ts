"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  CASE_STATUSES,
  CASE_TYPES,
  PRIORITIES,
  type CasePriority,
  type CaseStatus,
  type CaseType,
} from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "pdf", "mp4"]);

function getString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function getNullableString(formData: FormData, key: string) {
  const value = getString(formData, key);
  return value || null;
}

function getFileExtension(fileName: string) {
  if (!fileName.includes(".")) return "";
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function isAllowedAttachment(file: File) {
  const extension = getFileExtension(file.name);
  return ALLOWED_ATTACHMENT_EXTENSIONS.has(extension);
}

function isRedirectLikeError(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error
    && typeof (error as { digest?: unknown }).digest === "string"
    && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

async function ensureAccessUserId(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  user: { id: string; fullName: string | null },
) {
  try {
    const { data: accessUser, error: accessUserError } = await supabase
      .from("access_users")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (!accessUserError && accessUser?.id) {
      return accessUser.id;
    }

    const fallbackName = user.fullName?.trim() || "Sandbox User";
    const accessCode = `AUTO-${Math.random().toString(36).slice(2, 10)}`;

    const { data: createdUser, error: createError } = await supabase
      .from("access_users")
      .insert({
        id: user.id,
        full_name: fallbackName,
        access_code: accessCode,
        is_active: true,
      })
      .select("id")
      .maybeSingle();

    if (!createError && createdUser?.id) {
      return createdUser.id;
    }
  } catch {
    // Ignore access-user lookup failures in sandbox environments.
  }

  return user.id;
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

function mapWorkflowStatus(action: string): CaseStatus {
  if (action === "mark_in_progress") return "In Progress";
  if (action === "mark_completed") return "Resolved";
  return "In Progress";
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
  const safeActorId = await ensureAccessUserId(supabase, user);

  const updates: Database["public"]["Tables"]["customer_service_cases"]["Update"] = {
    status: validatedStatus,
  };
  if (newStatus === "Closed" || newStatus === "Completed" || newStatus === "Resolved") {
    updates.closed_at = new Date().toISOString();
  } else {
    updates.closed_at = null;
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
    actor_id: safeActorId,
    activity_type: "status_changed",
    summary: `Status changed to ${newStatus}`,
    details: { case_number: existingCase.case_number, status: newStatus },
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath("/cases/completed");
  revalidatePath("/dashboard");
  redirect(`/cases/${caseId}?success=status_saved`);
}

export async function updateCaseIssueDetailsAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const caseTypeInput = getString(formData, "case_type");
  const priorityInput = getString(formData, "priority");
  const issueDescription = getString(formData, "issue_description");

  if (!caseId || !issueDescription) {
    redirect(`/cases/${caseId || ""}?error=invalid_issue_update`);
  }

  const caseType: CaseType = CASE_TYPES.includes(caseTypeInput as (typeof CASE_TYPES)[number])
    ? (caseTypeInput as CaseType)
    : "General";
  const priority: CasePriority = PRIORITIES.includes(priorityInput as (typeof PRIORITIES)[number])
    ? (priorityInput as CasePriority)
    : "Medium";
  const { supabase, existingCase } = await getCaseOrRedirect(caseId);
  const safeActorId = await ensureAccessUserId(supabase, user);

  const updates: Database["public"]["Tables"]["customer_service_cases"]["Update"] = {
    case_type: caseType,
    priority,
    issue_description: issueDescription,
  };

  const { error } = await supabase
    .from("customer_service_cases")
    .update(updates as never)
    .eq("id", caseId);

  if (error) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
  }

  await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: safeActorId,
    activity_type: "issue_details_updated",
    summary: "Issue details updated",
    details: {
      case_number: existingCase.case_number,
      case_type: caseType,
      priority,
    },
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath("/dashboard");
  redirect(`/cases/${caseId}?success=issue_saved`);
}

export async function updateCaseWorkflowAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const workflowAction = getString(formData, "workflow_action");

  if (!caseId || !workflowAction) {
    redirect("/cases?error=invalid_workflow_action");
  }

  const { supabase, existingCase } = await getCaseOrRedirect(caseId);
  const safeActorId = await ensureAccessUserId(supabase, user);

  const nextStatus = mapWorkflowStatus(workflowAction);
  const updates: Database["public"]["Tables"]["customer_service_cases"]["Update"] = {
    status: nextStatus,
    closed_at: workflowAction === "mark_completed" ? new Date().toISOString() : null,
  };

  const { error } = await supabase
    .from("customer_service_cases")
    .update(updates as never)
    .eq("id", caseId);

  if (error) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
  }

  const summary = workflowAction === "mark_completed"
    ? "Case marked resolved"
    : workflowAction === "reopen_case"
      ? "Case reopened"
      : "Case marked in progress";

  await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: safeActorId,
    activity_type: "workflow_status_changed",
    summary,
    details: { case_number: existingCase.case_number, status: nextStatus },
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath("/cases/completed");
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
  const safeActorId = await ensureAccessUserId(supabase, user);

  const { error } = await supabase.from("case_notes").insert({
    case_id: caseId,
    note_type: noteType,
    content,
    created_by: safeActorId,
  });

  if (error) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
  }

  await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: safeActorId,
    activity_type: "note_added",
    summary: content.length > 160 ? `${content.slice(0, 157)}...` : content,
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
  const safeActorId = await ensureAccessUserId(supabase, user);

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
    ordered_by: safeActorId,
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
    actor_id: safeActorId,
    activity_type: "replacement_part_added",
    summary: `Replacement part added: ${partName}`,
  });

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/dashboard");
}

type WorkflowEventConfig = {
  summary: string;
};

type AutoSaveState = {
  ok: boolean;
  savedAt?: string;
  error?: string;
};

const WORKFLOW_EVENTS: Record<string, WorkflowEventConfig> = {
  customer_contacted: { summary: "Customer contacted" },
  replacement_part_ordered: { summary: "Replacement part ordered" },
  warranty_approved: { summary: "Warranty approved" },
  waiting_supplier: { summary: "Waiting on supplier" },
  waiting_customer: { summary: "Waiting on customer" },
  replacement_delivered: { summary: "Replacement delivered" },
  add_tracking_number: { summary: "Tracking number added" },
  request_supplier_approval: { summary: "Supplier approval requested" },
  schedule_technician: { summary: "Technician scheduled" },
  send_customer_email: { summary: "Customer email sent" },
  generate_warranty_claim: { summary: "Warranty claim generated" },
};

export async function addCaseWorkflowEventAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const eventType = getString(formData, "event_type");
  const trackingNumber = getString(formData, "tracking_number");

  if (!caseId || !eventType) {
    redirect(`/cases/${caseId || ""}?error=missing_event_type`);
  }

  const eventConfig = WORKFLOW_EVENTS[eventType];
  if (!eventConfig) {
    redirect(`/cases/${caseId}?error=invalid_event_type`);
  }

  const { supabase } = await getCaseOrRedirect(caseId);
  const safeActorId = await ensureAccessUserId(supabase, user);

  const details = trackingNumber ? { tracking_number: trackingNumber } : null;
  const summary = trackingNumber ? `${eventConfig.summary}: ${trackingNumber}` : eventConfig.summary;

  const { error } = await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: safeActorId,
    activity_type: eventType,
    summary,
    details,
  });

  if (error) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath("/dashboard");
}

export async function updateCaseWorkflowWorkspaceAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const statusInput = getString(formData, "status");
  const assignedEmployeeId = getNullableString(formData, "assigned_employee_id");
  const nextAction = getString(formData, "next_action");
  const etaDate = getString(formData, "eta_date");
  const trackingNumber = getString(formData, "tracking_number");

  if (!caseId || !CASE_STATUSES.includes(statusInput as (typeof CASE_STATUSES)[number])) {
    redirect(`/cases/${caseId || ""}?error=invalid_workflow_update`);
  }

  const status = statusInput as CaseStatus;
  const { supabase } = await getCaseOrRedirect(caseId);
  const safeActorId = await ensureAccessUserId(supabase, user);

  const { data: currentCase, error: caseLookupError } = await supabase
    .from("customer_service_cases")
    .select("id, case_number, status, assigned_employee_id")
    .eq("id", caseId)
    .maybeSingle();

  if (caseLookupError || !currentCase) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(caseLookupError?.message ?? "Case not found")}`);
  }

  const updatePayload: Database["public"]["Tables"]["customer_service_cases"]["Update"] = {
    status,
    assigned_employee_id: assignedEmployeeId,
    closed_at: status === "Closed" || status === "Completed" || status === "Resolved"
      ? new Date().toISOString()
      : null,
  };

  const { error: updateError } = await supabase
    .from("customer_service_cases")
    .update(updatePayload as never)
    .eq("id", caseId);

  if (updateError) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(updateError.message)}`);
  }

  const activityInserts: Database["public"]["Tables"]["case_activity"]["Insert"][] = [];

  if (status !== currentCase.status) {
    activityInserts.push({
      case_id: caseId,
      actor_id: safeActorId,
      activity_type: "status_changed",
      summary: `Status changed to ${status}`,
      details: { case_number: currentCase.case_number, status },
    });
  }

  if ((currentCase.assigned_employee_id ?? null) !== assignedEmployeeId) {
    activityInserts.push({
      case_id: caseId,
      actor_id: safeActorId,
      activity_type: "assigned_user_changed",
      summary: assignedEmployeeId ? "Assigned user updated" : "Assignee cleared",
      details: { case_number: currentCase.case_number, assigned_employee_id: assignedEmployeeId },
    });
  }

  if (nextAction || etaDate) {
    activityInserts.push({
      case_id: caseId,
      actor_id: safeActorId,
      activity_type: "next_action_set",
      summary: nextAction ? `Next action: ${nextAction}` : `ETA set: ${etaDate}`,
      details: { case_number: currentCase.case_number, next_action: nextAction || null, eta_date: etaDate || null },
    });
  }

  if (trackingNumber) {
    activityInserts.push({
      case_id: caseId,
      actor_id: safeActorId,
      activity_type: "add_tracking_number",
      summary: `Tracking number added: ${trackingNumber}`,
      details: { tracking_number: trackingNumber },
    });
  }

  if (activityInserts.length > 0) {
    await supabase.from("case_activity").insert(activityInserts as never);
  }

  revalidatePath(`/cases/${caseId}`);
  revalidatePath("/cases");
  revalidatePath("/cases/completed");
  revalidatePath("/dashboard");
  redirect(`/cases/${caseId}?success=workflow_saved`);
}

export async function autosaveIssueDetailsWorkspaceAction(
  _prevState: AutoSaveState,
  formData: FormData,
): Promise<AutoSaveState> {
  try {
    const user = await requireUser();

    const caseId = getString(formData, "case_id");
    const caseTypeInput = getString(formData, "case_type");
    const priorityInput = getString(formData, "priority");
    const issueDescription = getString(formData, "issue_description");

    if (!caseId || !issueDescription) {
      return { ok: false, error: "Missing required issue details" };
    }

    const caseType: CaseType = CASE_TYPES.includes(caseTypeInput as (typeof CASE_TYPES)[number])
      ? (caseTypeInput as CaseType)
      : "General";
    const priority: CasePriority = PRIORITIES.includes(priorityInput as (typeof PRIORITIES)[number])
      ? (priorityInput as CasePriority)
      : "Medium";

    const { supabase, existingCase } = await getCaseOrRedirect(caseId);
    const safeActorId = await ensureAccessUserId(supabase, user);
    const { data: currentCase, error: lookupError } = await supabase
      .from("customer_service_cases")
      .select("case_type, priority, issue_description")
      .eq("id", caseId)
      .maybeSingle();

    if (lookupError || !currentCase) {
      return { ok: false, error: lookupError?.message ?? "Case not found" };
    }

    const changed = currentCase.case_type !== caseType
      || currentCase.priority !== priority
      || currentCase.issue_description !== issueDescription;

    if (!changed) {
      return { ok: true, savedAt: new Date().toISOString() };
    }

    const { error } = await supabase
      .from("customer_service_cases")
      .update({
        case_type: caseType,
        priority,
        issue_description: issueDescription,
      } as never)
      .eq("id", caseId);

    if (error) {
      return { ok: false, error: error.message };
    }

    await supabase.from("case_activity").insert({
      case_id: caseId,
      actor_id: safeActorId,
      activity_type: "issue_details_updated",
      summary: "Issue details updated",
      details: {
        case_number: existingCase.case_number,
        case_type: caseType,
        priority,
      },
    });

    revalidatePath(`/cases/${caseId}`);
    revalidatePath("/cases");
    revalidatePath("/dashboard");

    return { ok: true, savedAt: new Date().toISOString() };
  } catch (error) {
    if (isRedirectLikeError(error)) throw error;
    return { ok: false, error: error instanceof Error ? error.message : "Could not autosave issue details" };
  }
}

export async function autosaveWorkflowWorkspaceAction(
  _prevState: AutoSaveState,
  formData: FormData,
): Promise<AutoSaveState> {
  try {
    const user = await requireUser();

    const caseId = getString(formData, "case_id");
    const statusInput = getString(formData, "status");
    const assignedEmployeeId = getNullableString(formData, "assigned_employee_id");
    const nextAction = getString(formData, "next_action");
    const etaDate = getString(formData, "eta_date");

    if (!caseId || !CASE_STATUSES.includes(statusInput as (typeof CASE_STATUSES)[number])) {
      return { ok: false, error: "Invalid workflow values" };
    }

    const status = statusInput as CaseStatus;
    const { supabase } = await getCaseOrRedirect(caseId);
    const safeActorId = await ensureAccessUserId(supabase, user);

    const { data: currentCase, error: caseLookupError } = await supabase
      .from("customer_service_cases")
      .select("id, case_number, status, assigned_employee_id")
      .eq("id", caseId)
      .maybeSingle();

    if (caseLookupError || !currentCase) {
      return { ok: false, error: caseLookupError?.message ?? "Case not found" };
    }

    const statusChanged = status !== currentCase.status;
    const assigneeChanged = (currentCase.assigned_employee_id ?? null) !== assignedEmployeeId;

    if (statusChanged || assigneeChanged) {
      const { error: updateError } = await supabase
        .from("customer_service_cases")
        .update({
          status,
          assigned_employee_id: assignedEmployeeId,
          closed_at: status === "Closed" || status === "Completed" || status === "Resolved"
            ? new Date().toISOString()
            : null,
        } as never)
        .eq("id", caseId);

      if (updateError) {
        return { ok: false, error: updateError.message };
      }
    }

    const activityInserts: Database["public"]["Tables"]["case_activity"]["Insert"][] = [];

    if (statusChanged) {
      activityInserts.push({
        case_id: caseId,
        actor_id: safeActorId,
        activity_type: "status_changed",
        summary: `Status changed to ${status}`,
        details: { case_number: currentCase.case_number, status },
      });
    }

    if (assigneeChanged) {
      activityInserts.push({
        case_id: caseId,
        actor_id: safeActorId,
        activity_type: "assigned_user_changed",
        summary: assignedEmployeeId ? "Assigned user updated" : "Assignee cleared",
        details: { case_number: currentCase.case_number, assigned_employee_id: assignedEmployeeId },
      });
    }

    const { data: latestNextActionEvent } = await supabase
      .from("case_activity")
      .select("details")
      .eq("case_id", caseId)
      .eq("activity_type", "next_action_set")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const latestDetails = latestNextActionEvent?.details as Record<string, unknown> | null;
    const previousNextAction = typeof latestDetails?.next_action === "string" ? latestDetails.next_action : "";
    const previousEtaDate = typeof latestDetails?.eta_date === "string" ? latestDetails.eta_date : "";
    const nextActionChanged = nextAction !== previousNextAction || etaDate !== previousEtaDate;

    if (nextActionChanged && (nextAction || etaDate)) {
      activityInserts.push({
        case_id: caseId,
        actor_id: safeActorId,
        activity_type: "next_action_set",
        summary: nextAction ? `Next action: ${nextAction}` : `ETA set: ${etaDate}`,
        details: { case_number: currentCase.case_number, next_action: nextAction || null, eta_date: etaDate || null },
      });
    }

    if (activityInserts.length > 0) {
      await supabase.from("case_activity").insert(activityInserts as never);
    }

    revalidatePath(`/cases/${caseId}`);
    revalidatePath("/cases");
    revalidatePath("/cases/completed");
    revalidatePath("/dashboard");

    return { ok: true, savedAt: new Date().toISOString() };
  } catch (error) {
    if (isRedirectLikeError(error)) throw error;
    return { ok: false, error: error instanceof Error ? error.message : "Could not autosave workflow" };
  }
}

export async function uploadAttachmentAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const files = formData.getAll("attachments").filter((item): item is File => item instanceof File && item.size > 0);

  if (!caseId || files.length === 0) {
    redirect(`/cases/${caseId || ""}?error=attachment_missing`);
  }

  const { supabase } = await getCaseOrRedirect(caseId);
  const safeActorId = await ensureAccessUserId(supabase, user);

  for (const file of files) {
    if (!isAllowedAttachment(file)) {
      redirect(`/cases/${caseId}?error=Unsupported+file+type.+Use+JPG,+PNG,+HEIC,+PDF,+or+MP4`);
    }
  }

  for (const file of files) {
    const fileExtension = getFileExtension(file.name) || "bin";
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
      uploaded_by: safeActorId,
    });

    if (dbError) {
      redirect(`/cases/${caseId}?error=${encodeURIComponent(dbError.message)}`);
    }
  }

  await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: safeActorId,
    activity_type: "file_uploaded",
    summary: files.length === 1 ? `Attachment uploaded: ${files[0].name}` : `${files.length} attachments uploaded`,
  });

  revalidatePath(`/cases/${caseId}`);
}

export async function deleteAttachmentAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const attachmentId = getString(formData, "attachment_id");

  if (!caseId || !attachmentId) {
    redirect(`/cases/${caseId || ""}?error=missing_attachment_reference`);
  }

  const { supabase } = await getCaseOrRedirect(caseId);
  const safeActorId = await ensureAccessUserId(supabase, user);

  const { data: attachment, error: lookupError } = await supabase
    .from("case_attachments")
    .select("id, file_name, file_path")
    .eq("id", attachmentId)
    .eq("case_id", caseId)
    .maybeSingle();

  if (lookupError || !attachment) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(lookupError?.message ?? "Attachment not found")}`);
  }

  await supabase.storage
    .from("case-attachments")
    .remove([attachment.file_path]);

  const { error: deleteError } = await supabase
    .from("case_attachments")
    .delete()
    .eq("id", attachmentId)
    .eq("case_id", caseId);

  if (deleteError) {
    redirect(`/cases/${caseId}?error=${encodeURIComponent(deleteError.message)}`);
  }

  await supabase.from("case_activity").insert({
    case_id: caseId,
    actor_id: safeActorId,
    activity_type: "file_deleted",
    summary: `Attachment deleted: ${attachment.file_name}`,
  });

  revalidatePath(`/cases/${caseId}`);
}

export async function deleteCaseAction(formData: FormData) {
  const user = await requireUser();

  const caseId = getString(formData, "case_id");
  const confirmationCode = getString(formData, "confirmation_code");

  if (!caseId) {
    redirect("/cases?error=missing_case_reference");
  }

  if (confirmationCode !== "9822") {
    redirect(`/cases/${caseId}?error=invalid_delete_confirmation`);
  }

  const supabase = getSupabaseAdmin();
  const safeActorId = await ensureAccessUserId(supabase, user);
  const { data: existingCase, error: lookupError } = await supabase
    .from("customer_service_cases")
    .select("id, case_number, created_by")
    .eq("id", caseId)
    .maybeSingle();

  if (lookupError || !existingCase) {
    redirect("/cases?error=case_not_found");
  }

  if (existingCase.created_by !== safeActorId) {
    redirect("/cases?error=case_delete_forbidden");
  }

  const { data: attachments } = await supabase
    .from("case_attachments")
    .select("file_path")
    .eq("case_id", caseId);

  const storagePaths = (attachments ?? [])
    .map((attachment) => (typeof attachment.file_path === "string" ? attachment.file_path : null))
    .filter((value): value is string => Boolean(value));

  if (storagePaths.length > 0) {
    await supabase.storage.from("case-attachments").remove(storagePaths);
  }

  const { error: deleteError } = await supabase
    .from("customer_service_cases")
    .delete()
    .eq("id", caseId);

  if (deleteError) {
    redirect(`/cases?error=${encodeURIComponent(deleteError.message)}`);
  }

  revalidatePath("/cases");
  revalidatePath("/dashboard");
  redirect("/cases?success=case_deleted");
}
