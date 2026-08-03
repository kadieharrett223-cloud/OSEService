"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "pdf", "mp4"]);

function emptyToNull(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
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

function normalizeInstallationStatus(value: string) {
  if (value === "In Progress" || value === "Completed" || value === "Blocked") {
    return value;
  }
  return "New";
}

export async function createInstallationAction(formData: FormData) {
  const user = await requireUser();
  const supabase = getSupabaseAdmin();

  try {
    const invoiceNumber = String(formData.get("invoice_number") ?? "").trim();
    if (!invoiceNumber) {
      redirect("/installation/new?error=Invoice+number+is+required");
    }

    const customerName = String(formData.get("customer_name") ?? "").trim();
    const companyName = emptyToNull(formData.get("company_name"));
    const phone = emptyToNull(formData.get("phone"));
    const email = emptyToNull(formData.get("email"));
    const shippingAddress = emptyToNull(formData.get("shipping_address"));
    const summary = String(formData.get("summary") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const status = normalizeInstallationStatus(String(formData.get("status") ?? "New").trim());

    if (!customerName) {
      redirect("/installation/new?error=Customer+name+is+required");
    }

    if (!summary) {
      redirect("/installation/new?error=Installation+summary+is+required");
    }

    const uploadedFiles = formData
      .getAll("attachments")
      .filter((item): item is File => item instanceof File && item.size > 0);

    for (const file of uploadedFiles) {
      if (!isAllowedAttachment(file)) {
        redirect("/installation/new?error=Unsupported+file+type.+Use+JPG,+PNG,+HEIC,+PDF,+or+MP4");
      }
    }

    const { data: createdJob, error: jobError } = await supabase
      .from("installation_jobs")
      .insert({
        invoice_number: invoiceNumber,
        quickbooks_invoice_id: emptyToNull(formData.get("quickbooks_invoice_id")),
        quickbooks_customer_id: emptyToNull(formData.get("quickbooks_customer_id")),
        customer_name: customerName,
        company_name: companyName,
        phone,
        email,
        shipping_address: shippingAddress,
        summary,
        status,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (jobError || !createdJob) {
      redirect(`/installation/new?error=${encodeURIComponent(jobError?.message ?? "Could not create installation")}`);
    }

    if (notes) {
      await supabase.from("installation_notes").insert({
        installation_job_id: createdJob.id,
        content: notes,
        created_by: user.id,
      });
    }

    for (const file of uploadedFiles) {
      const fileExtension = getFileExtension(file.name) || "bin";
      const safeFileName = `${Date.now()}-${crypto.randomUUID()}.${fileExtension}`;
      const storagePath = `${createdJob.id}/${safeFileName}`;

      const { error: uploadError } = await supabase.storage
        .from("case-attachments")
        .upload(storagePath, file, {
          cacheControl: "3600",
          upsert: false,
          contentType: file.type || undefined,
        });

      if (uploadError) {
        redirect(`/installation/${createdJob.id}?error=${encodeURIComponent(uploadError.message)}`);
      }

      const { error: attachmentError } = await supabase.from("installation_photos").insert({
        installation_job_id: createdJob.id,
        file_path: storagePath,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type || null,
        uploaded_by: user.id,
      });

      if (attachmentError) {
        redirect(`/installation/${createdJob.id}?error=${encodeURIComponent(attachmentError.message)}`);
      }
    }

    revalidatePath("/installation");
    redirect(`/installation/${createdJob.id}`);
  } catch (error) {
    if (isRedirectLikeError(error)) {
      throw error;
    }

    redirect("/installation/new?error=Unable+to+create+installation");
  }
}
