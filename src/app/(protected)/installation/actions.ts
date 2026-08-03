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
  if (value === "New Install" || value === "New" || value === "new") {
    return "In Progress";
  }

  if (value === "In Progress" || value === "Completed" || value === "Blocked") {
    return value;
  }

  return "In Progress";
}

function normalizeLookupQuery(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

function buildAutofillUrl(payload: Record<string, string>) {
  const params = new URLSearchParams();
  params.set("prefilled", "1");

  for (const [key, value] of Object.entries(payload)) {
    if (value) {
      params.set(key, value);
    }
  }

  return `/installation/new?${params.toString()}`;
}

function extractInvoiceAutofillFallbacks(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") {
    return { email: "", phone: "", shippingAddress: "", billingAddress: "" };
  }

  const payload = rawPayload as Record<string, unknown>;
  const billEmail = payload.BillEmail as Record<string, unknown> | undefined;
  const primaryEmail = payload.PrimaryEmailAddr as Record<string, unknown> | undefined;
  const billPhone = payload.BillPhone as Record<string, unknown> | undefined;
  const primaryPhone = payload.PrimaryPhone as Record<string, unknown> | undefined;

  const email = typeof billEmail?.Address === "string"
    ? billEmail.Address
    : typeof primaryEmail?.Address === "string"
      ? primaryEmail.Address
      : "";

  const phone = typeof billPhone?.FreeFormNumber === "string"
    ? billPhone.FreeFormNumber
    : typeof primaryPhone?.FreeFormNumber === "string"
      ? primaryPhone.FreeFormNumber
      : "";

  const shippingAddress = typeof payload.ShipAddr === "object" && payload.ShipAddr !== null
    ? [
        (payload.ShipAddr as Record<string, unknown>).Line1,
        (payload.ShipAddr as Record<string, unknown>).Line2,
        (payload.ShipAddr as Record<string, unknown>).Line3,
        (payload.ShipAddr as Record<string, unknown>).Line4,
        (payload.ShipAddr as Record<string, unknown>).Line5,
        [
          (payload.ShipAddr as Record<string, unknown>).City,
          (payload.ShipAddr as Record<string, unknown>).CountrySubDivisionCode,
          (payload.ShipAddr as Record<string, unknown>).PostalCode,
        ].filter(Boolean).join(" "),
        (payload.ShipAddr as Record<string, unknown>).Country,
      ].filter((line): line is string => typeof line === "string" && line.trim().length > 0).map((line) => line.trim()).join(", ")
    : "";

  const billingAddress = typeof payload.BillAddr === "object" && payload.BillAddr !== null
    ? [
        (payload.BillAddr as Record<string, unknown>).Line1,
        (payload.BillAddr as Record<string, unknown>).Line2,
        (payload.BillAddr as Record<string, unknown>).Line3,
        (payload.BillAddr as Record<string, unknown>).Line4,
        (payload.BillAddr as Record<string, unknown>).Line5,
        [
          (payload.BillAddr as Record<string, unknown>).City,
          (payload.BillAddr as Record<string, unknown>).CountrySubDivisionCode,
          (payload.BillAddr as Record<string, unknown>).PostalCode,
        ].filter(Boolean).join(" "),
        (payload.BillAddr as Record<string, unknown>).Country,
      ].filter((line): line is string => typeof line === "string" && line.trim().length > 0).map((line) => line.trim()).join(", ")
    : "";

  return { email, phone, shippingAddress: shippingAddress || billingAddress, billingAddress };
}

export async function quickbooksInstallationAutofillAction(formData: FormData) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const query = normalizeLookupQuery(String(formData.get("invoice_number") ?? ""));
  if (!query) {
    redirect("/installation/new?error=Enter+an+invoice+number");
  }

  const { data: invoice } = await supabase
    .from("quickbooks_invoices")
    .select("id, quickbooks_invoice_id, invoice_number, quickbooks_customer_id, invoice_date, invoice_total, payment_status, billing_address, shipping_address, raw_payload")
    .or(`invoice_number.ilike.%${query}%,quickbooks_invoice_id.ilike.%${query}%`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!invoice) {
    redirect("/installation/new?error=No+invoice+match+found");
  }

  const { data: customer } = invoice.quickbooks_customer_id
    ? await supabase
        .from("customers")
        .select("full_name, company_name, phone, email, shipping_address, quickbooks_customer_id")
        .eq("quickbooks_customer_id", invoice.quickbooks_customer_id)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const invoiceFallbacks = extractInvoiceAutofillFallbacks(invoice.raw_payload);

  redirect(
    buildAutofillUrl({
      invoice_number: invoice.invoice_number,
      customer_name: customer?.full_name ?? "",
      company_name: customer?.company_name ?? "",
      phone: customer?.phone ?? invoiceFallbacks.phone,
      email: customer?.email ?? invoiceFallbacks.email,
      shipping_address: invoiceFallbacks.shippingAddress || invoice.shipping_address || customer?.shipping_address || "",
      quickbooks_customer_id: customer?.quickbooks_customer_id ?? invoice.quickbooks_customer_id ?? "",
      quickbooks_invoice_id: invoice.id,
      quickbooks_invoice_external_id: invoice.quickbooks_invoice_id ?? "",
      quickbooks_invoice_link: invoice.quickbooks_invoice_id
        ? `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(invoice.quickbooks_invoice_id)}`
        : "",
    }),
  );
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
    const notes = String(formData.get("notes") ?? "").trim();
    const status = normalizeInstallationStatus(String(formData.get("status") ?? "New").trim());

    if (!customerName) {
      redirect("/installation/new?error=Customer+name+is+required");
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
        summary: null,
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
