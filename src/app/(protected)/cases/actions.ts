"use server";

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
  invoice_date?: string;
  invoice_total?: string;
  payment_status?: string;
  date_of_purchase?: string;
};

function emptyToNull(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
}

function normalizeLookupQuery(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
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
    .select("quickbooks_invoice_id, invoice_number, quickbooks_customer_id, invoice_date, invoice_total, payment_status, billing_address, shipping_address")
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
        .select("quickbooks_invoice_id, invoice_number, quickbooks_customer_id, invoice_date, invoice_total, payment_status, billing_address, shipping_address")
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

  if (!customer && !invoice) {
    redirect("/cases/new?error=No+QuickBooks+match+found");
  }

  redirect(
    buildAutofillUrl({
      customer_name: customer?.full_name ?? "",
      company_name: customer?.company_name ?? "",
      phone: customer?.phone ?? "",
      email: customer?.email ?? "",
      shipping_address: customer?.shipping_address ?? invoice?.shipping_address ?? "",
      billing_address: invoice?.billing_address ?? "",
      quickbooks_customer_id: customer?.quickbooks_customer_id ?? invoice?.quickbooks_customer_id ?? "",
      quickbooks_invoice_id: invoice?.quickbooks_invoice_id ?? "",
      quickbooks_invoice_number: invoice?.invoice_number ?? "",
      invoice_date: invoice?.invoice_date ?? "",
      invoice_total: invoice?.invoice_total != null ? String(invoice.invoice_total) : "",
      payment_status: invoice?.payment_status ?? "",
      date_of_purchase: invoice?.invoice_date ?? "",
    }),
  );
}

export async function createCaseAction(formData: FormData) {
  const user = await requireUser();
  const supabase = getSupabaseAdmin();

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

  const priorityInput = String(formData.get("priority") ?? "Medium");
  const statusInput = String(formData.get("status") ?? "New");

  const priority: CasePriority = PRIORITIES.includes(
    priorityInput as (typeof PRIORITIES)[number],
  )
    ? (priorityInput as CasePriority)
    : "Medium";
  const status: CaseStatus = CASE_STATUSES.includes(
    statusInput as (typeof CASE_STATUSES)[number],
  )
    ? (statusInput as CaseStatus)
    : "New";

  const caseTypeInput = String(formData.get("case_type") ?? "General");
  const caseType: CaseType = CASE_TYPES.includes(
    caseTypeInput as (typeof CASE_TYPES)[number],
  )
    ? (caseTypeInput as CaseType)
    : "General";

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
      product_model: emptyToNull(formData.get("product_model")),
      serial_number: emptyToNull(formData.get("serial_number")),
      date_of_purchase: dateOfPurchase,
      issue_reported_at: new Date().toISOString(),
      issue_description: issueDescription,
      assigned_employee_id: emptyToNull(formData.get("assigned_employee_id")),
      priority,
      status,
      internal_notes: emptyToNull(formData.get("internal_notes")),
      customer_facing_notes: emptyToNull(formData.get("customer_facing_notes")),
      created_by: user.id,
    })
    .select("id, case_number")
    .single();

  if (caseError || !createdCase) {
    redirect(`/cases/new?error=${encodeURIComponent(caseError?.message ?? "Could not create case")}`);
  }

  await supabase.from("case_activity").insert({
    case_id: createdCase.id,
    actor_id: user.id,
    activity_type: "case_created",
    summary: `Case created by ${user.fullName ?? "Unknown"}`,
    details: { status, priority },
  });

  revalidatePath("/dashboard");
  revalidatePath("/cases");
  redirect(`/cases/${createdCase.id}`);
}
