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

type AutofillPayload = {
  customer_name?: string;
  company_name?: string;
  phone?: string;
  email?: string;
  shipping_address?: string;
  billing_address?: string;
  quickbooks_customer_id?: string;
  quickbooks_invoice_id?: string;
  quickbooks_invoice_number?: string;
  quickbooks_invoice_external_id?: string;
  quickbooks_invoice_link?: string;
  invoice_date?: string;
  invoice_total?: string;
  payment_status?: string;
  date_of_purchase?: string;
  products_purchased?: string;
};

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "pdf", "mp4"]);

function emptyToNull(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
}

function normalizeLookupQuery(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

function getFileExtension(fileName: string) {
  if (!fileName.includes(".")) return "";
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function isAllowedAttachment(file: File) {
  const extension = getFileExtension(file.name);
  return ALLOWED_ATTACHMENT_EXTENSIONS.has(extension);
}

function getInvoiceLink(quickbooksInvoiceExternalId: string | null | undefined) {
  if (!quickbooksInvoiceExternalId) return "";
  return `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(quickbooksInvoiceExternalId)}`;
}

function isRedirectLikeError(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error
    && typeof (error as { digest?: unknown }).digest === "string"
    && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

function parseProductsPurchased(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return "";

  const payload = rawPayload as { Line?: unknown[] };
  const lines = Array.isArray(payload.Line) ? payload.Line : [];

  const productLines = lines
    .map((line, index) => {
      if (!line || typeof line !== "object") return null;

      const entry = line as {
        Description?: unknown;
        Qty?: unknown;
        SalesItemLineDetail?: { Qty?: unknown; ItemRef?: { name?: unknown } };
      };

      const explicitDescription = typeof entry.Description === "string" ? entry.Description.trim() : "";
      const itemRefName = typeof entry.SalesItemLineDetail?.ItemRef?.name === "string"
        ? entry.SalesItemLineDetail.ItemRef.name.trim()
        : "";

      const description = explicitDescription || itemRefName;
      if (!description) return null;

      const qtyRaw = entry.SalesItemLineDetail?.Qty ?? entry.Qty;
      const qty = typeof qtyRaw === "number" || typeof qtyRaw === "string"
        ? String(qtyRaw).trim()
        : "";

      return `${index + 1}. ${description}${qty ? ` (Qty ${qty})` : ""}`;
    })
    .filter((line): line is string => Boolean(line));

  return productLines.join("\n");
}

function formatAddressFromRaw(address: unknown) {
  if (!address || typeof address !== "object") return "";

  const addressRecord = address as Record<string, unknown>;
  const asText = [
    addressRecord.Line1,
    addressRecord.Line2,
    addressRecord.Line3,
    [addressRecord.City, addressRecord.CountrySubDivisionCode, addressRecord.PostalCode].filter(Boolean).join(" "),
    addressRecord.Country,
  ]
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => line.trim());

  return asText.join(", ");
}

function extractInvoiceAutofillFallbacks(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") {
    return { email: "", phone: "", shippingAddress: "" };
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

  const shippingAddress = formatAddressFromRaw(payload.ShipAddr) || formatAddressFromRaw(payload.BillAddr);

  return { email, phone, shippingAddress };
}

function buildAutofillUrl(payload: AutofillPayload) {
  const params = new URLSearchParams();
  params.set("prefilled", "1");

  for (const [key, value] of Object.entries(payload)) {
    if (value) {
      params.set(key, value);
    }
  }

  return `/cases/new?${params.toString()}`;
}

export async function quickbooksAutofillAction(formData: FormData) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const query = normalizeLookupQuery(String(formData.get("lookup_query") ?? ""));
  if (!query) {
    redirect("/cases/new?error=Enter+QuickBooks+customer+or+invoice");
  }

  const invoiceByNumberPromise = supabase
    .from("quickbooks_invoices")
    .select("id, quickbooks_invoice_id, invoice_number, quickbooks_customer_id, invoice_date, invoice_total, payment_status, billing_address, shipping_address, raw_payload")
    .or(`invoice_number.ilike.%${query}%,quickbooks_invoice_id.ilike.%${query}%`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const customerByNamePromise = supabase
    .from("customers")
    .select("full_name, company_name, phone, email, shipping_address, quickbooks_customer_id")
    .or(`full_name.ilike.%${query}%,company_name.ilike.%${query}%,quickbooks_customer_id.eq.${query}`)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const [{ data: invoiceByNumber }, { data: customerByName }] = await Promise.all([
    invoiceByNumberPromise,
    customerByNamePromise,
  ]);

  const qbCustomerId = invoiceByNumber?.quickbooks_customer_id ?? customerByName?.quickbooks_customer_id ?? null;

  const latestInvoiceByCustomer = qbCustomerId
    ? await supabase
        .from("quickbooks_invoices")
        .select("id, quickbooks_invoice_id, invoice_number, quickbooks_customer_id, invoice_date, invoice_total, payment_status, billing_address, shipping_address, raw_payload")
        .eq("quickbooks_customer_id", qbCustomerId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const latestCustomerByQbId = qbCustomerId
    ? await supabase
        .from("customers")
        .select("full_name, company_name, phone, email, shipping_address, quickbooks_customer_id")
        .eq("quickbooks_customer_id", qbCustomerId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const customer = latestCustomerByQbId.data ?? customerByName;
  const invoice = invoiceByNumber ?? latestInvoiceByCustomer.data;
  const invoiceFallbacks = extractInvoiceAutofillFallbacks(invoice?.raw_payload);

  if (!customer && !invoice) {
    redirect("/cases/new?error=No+QuickBooks+match+found");
  }

  redirect(
    buildAutofillUrl({
      customer_name: customer?.full_name ?? "",
      company_name: customer?.company_name ?? "",
      phone: customer?.phone ?? invoiceFallbacks.phone,
      email: customer?.email ?? invoiceFallbacks.email,
      shipping_address: customer?.shipping_address ?? invoice?.shipping_address ?? invoiceFallbacks.shippingAddress,
      billing_address: invoice?.billing_address ?? "",
      quickbooks_customer_id: customer?.quickbooks_customer_id ?? invoice?.quickbooks_customer_id ?? "",
      quickbooks_invoice_id: invoice?.id ?? "",
      quickbooks_invoice_number: invoice?.invoice_number ?? "",
      quickbooks_invoice_external_id: invoice?.quickbooks_invoice_id ?? "",
      quickbooks_invoice_link: getInvoiceLink(invoice?.quickbooks_invoice_id),
      invoice_date: invoice?.invoice_date ?? "",
      invoice_total: invoice?.invoice_total != null ? String(invoice.invoice_total) : "",
      payment_status: invoice?.payment_status ?? "",
      date_of_purchase: invoice?.invoice_date ?? "",
      products_purchased: parseProductsPurchased(invoice?.raw_payload),
    }),
  );
}

export async function createCaseAction(formData: FormData) {
  const user = await requireUser();
  const supabase = getSupabaseAdmin();

  let createdCaseId: string | null = null;

  try {
    const customerName = String(formData.get("customer_name") ?? "").trim();
    const companyName = emptyToNull(formData.get("company_name"));
    const phone = emptyToNull(formData.get("phone"));
    const email = emptyToNull(formData.get("email"));
    const shippingAddress = emptyToNull(formData.get("shipping_address"));
    const quickbooksCustomerId = emptyToNull(formData.get("quickbooks_customer_id"));

    if (!customerName) {
      redirect("/cases/new?error=Customer+name+is+required");
    }

    const issueDescription = String(formData.get("issue_description") ?? "").trim();
    if (!issueDescription) {
      redirect("/cases/new?error=Issue+description+is+required");
    }

    const customerNote = emptyToNull(formData.get("customer_note"));
    const internalNotes = emptyToNull(formData.get("internal_notes"));
    const draftInternalNotes = formData
      .getAll("draft_internal_notes")
      .map((item) => String(item).trim())
      .filter(Boolean);

    const nextStep = emptyToNull(formData.get("next_step"));
    const etaDate = emptyToNull(formData.get("eta_date"));
    const trackingNumber = emptyToNull(formData.get("tracking_number"));
    const assignedEmployeeId = emptyToNull(formData.get("assigned_employee_id"));

    const priorityInput = String(formData.get("priority") ?? "Medium");
    const statusInput = String(formData.get("status") ?? "In Progress");

    const priority: CasePriority = PRIORITIES.includes(
      priorityInput as (typeof PRIORITIES)[number],
    )
      ? (priorityInput as CasePriority)
      : "Medium";
    const status: CaseStatus = CASE_STATUSES.includes(
      statusInput as (typeof CASE_STATUSES)[number],
    )
      ? (statusInput as CaseStatus)
      : "In Progress";

    const caseTypeInput = String(formData.get("case_type") ?? "General");
    const caseType: CaseType = CASE_TYPES.includes(
      caseTypeInput as (typeof CASE_TYPES)[number],
    )
      ? (caseTypeInput as CaseType)
      : "General";

    const uploadedFiles = formData
      .getAll("attachments")
      .filter((item): item is File => item instanceof File && item.size > 0);

    for (const file of uploadedFiles) {
      if (!isAllowedAttachment(file)) {
        redirect("/cases/new?error=Unsupported+file+type.+Use+JPG,+PNG,+HEIC,+PDF,+or+MP4");
      }
    }

    const quickbooksInvoiceId = emptyToNull(formData.get("quickbooks_invoice_id"));
    const quickbooksInvoiceNumber = emptyToNull(formData.get("quickbooks_invoice_number"));

    let dateOfPurchase = emptyToNull(formData.get("date_of_purchase"));
    if (!dateOfPurchase && (quickbooksInvoiceId || quickbooksInvoiceNumber)) {
      let invoiceQuery = supabase
        .from("quickbooks_invoices")
        .select("invoice_date")
        .limit(1);

      if (quickbooksInvoiceId) {
        invoiceQuery = invoiceQuery.eq("quickbooks_invoice_id", quickbooksInvoiceId);
      } else if (quickbooksInvoiceNumber) {
        invoiceQuery = invoiceQuery.eq("invoice_number", quickbooksInvoiceNumber);
      }

      const { data: invoiceRecord } = await invoiceQuery.maybeSingle();
      dateOfPurchase = invoiceRecord?.invoice_date ?? null;
    }

    let customerQuery = supabase.from("customers").select("id").limit(1);

    if (quickbooksCustomerId) {
      customerQuery = customerQuery.eq("quickbooks_customer_id", quickbooksCustomerId);
    } else if (email) {
      customerQuery = customerQuery.eq("email", email);
    } else {
      customerQuery = customerQuery
        .eq("full_name", customerName)
        .eq("company_name", companyName ?? "");
    }

    const { data: existingCustomer } = await customerQuery.maybeSingle();

    let customerId = existingCustomer?.id;

    if (!customerId) {
      const { data: customerInsert, error: customerError } = await supabase
        .from("customers")
        .insert({
          full_name: customerName,
          company_name: companyName,
          phone,
          email,
          shipping_address: shippingAddress,
          quickbooks_customer_id: quickbooksCustomerId,
        })
        .select("id")
        .single();

      if (customerError || !customerInsert) {
        redirect(`/cases/new?error=${encodeURIComponent(customerError?.message ?? "Could not create customer")}`);
      }

      customerId = customerInsert.id;
    }

    const { data: createdCase, error: caseError } = await supabase
      .from("customer_service_cases")
      .insert({
        customer_id: customerId,
        case_type: caseType,
        quickbooks_invoice_id: quickbooksInvoiceId,
        quickbooks_invoice_number: quickbooksInvoiceNumber,
        quickbooks_invoice_link: emptyToNull(formData.get("quickbooks_invoice_link")),
        product_model: null,
        serial_number: null,
        date_of_purchase: dateOfPurchase,
        issue_reported_at: new Date().toISOString(),
        issue_description: issueDescription,
        assigned_employee_id: assignedEmployeeId,
        priority,
        status,
        internal_notes: [
          internalNotes,
          nextStep ? `Next step: ${nextStep}` : null,
          etaDate ? `ETA: ${etaDate}` : null,
          trackingNumber ? `Tracking number: ${trackingNumber}` : null,
        ].filter(Boolean).join("\n") || null,
        customer_facing_notes: emptyToNull(formData.get("customer_facing_notes")),
        created_by: user.id,
      })
      .select("id, case_number")
      .single();

    if (caseError || !createdCase) {
      redirect(`/cases/new?error=${encodeURIComponent(caseError?.message ?? "Could not create case")}`);
    }

    createdCaseId = createdCase.id;

    await supabase.from("case_activity").insert({
      case_id: createdCase.id,
      actor_id: user.id,
      activity_type: "case_created",
      summary: `Case created by ${user.fullName ?? "Unknown"}`,
      details: {
        status,
        priority,
        assigned_employee_id: assignedEmployeeId,
        next_step: nextStep,
        eta_date: etaDate,
      },
    });

    if (customerNote) {
      await supabase.from("case_notes").insert({
        case_id: createdCase.id,
        note_type: "customer",
        content: customerNote,
        created_by: user.id,
      });

      await supabase.from("case_activity").insert({
        case_id: createdCase.id,
        actor_id: user.id,
        activity_type: "note_added",
        summary: "Customer note added",
      });
    }

    const allInternalNotes = [
      ...(internalNotes ? [internalNotes] : []),
      ...draftInternalNotes,
    ];

    for (const note of allInternalNotes) {
      await supabase.from("case_notes").insert({
        case_id: createdCase.id,
        note_type: "internal",
        content: note,
        created_by: user.id,
      });

      await supabase.from("case_activity").insert({
        case_id: createdCase.id,
        actor_id: user.id,
        activity_type: "note_added",
        summary: "Internal note added",
      });
    }

    if (trackingNumber) {
      await supabase.from("case_activity").insert({
        case_id: createdCase.id,
        actor_id: user.id,
        activity_type: "add_tracking_number",
        summary: `Tracking number added: ${trackingNumber}`,
        details: { tracking_number: trackingNumber },
      });
    }

    if (uploadedFiles.length > 0) {
      for (const file of uploadedFiles) {
        const fileExtension = getFileExtension(file.name) || "bin";
        const safeFileName = `${Date.now()}-${crypto.randomUUID()}.${fileExtension}`;
        const storagePath = `${createdCase.id}/${safeFileName}`;

        const { error: uploadError } = await supabase.storage
          .from("case-attachments")
          .upload(storagePath, file, {
            cacheControl: "3600",
            upsert: false,
            contentType: file.type || undefined,
          });

        if (uploadError) {
          redirect(`/cases/${createdCase.id}?error=${encodeURIComponent(uploadError.message)}`);
        }

        const { error: attachmentError } = await supabase.from("case_attachments").insert({
          case_id: createdCase.id,
          file_path: storagePath,
          file_name: file.name,
          file_size: file.size,
          mime_type: file.type || null,
          uploaded_by: user.id,
        });

        if (attachmentError) {
          redirect(`/cases/${createdCase.id}?error=${encodeURIComponent(attachmentError.message)}`);
        }
      }

      await supabase.from("case_activity").insert({
        case_id: createdCase.id,
        actor_id: user.id,
        activity_type: "file_uploaded",
        summary: uploadedFiles.length === 1 ? `Attachment uploaded: ${uploadedFiles[0].name}` : `${uploadedFiles.length} attachments uploaded`,
      });
    }

    revalidatePath("/dashboard");
    revalidatePath("/cases");
    redirect(`/cases/${createdCase.id}`);
  } catch (error) {
    if (isRedirectLikeError(error)) {
      throw error;
    }

    if (createdCaseId) {
      redirect(`/cases/${createdCaseId}?error=Case+created+with+follow-up+errors`);
    }

    redirect("/cases/new?error=Unable+to+create+case");
  }
}
