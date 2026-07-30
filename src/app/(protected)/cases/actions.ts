"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  CASE_STATUSES,
  PRIORITIES,
  type CasePriority,
  type CaseStatus,
} from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type AutofillPayload = {
  customer_name?: string;
  company_name?: string;
  phone?: string;
  email?: string;
  shipping_address?: string;
  quickbooks_customer_id?: string;
  quickbooks_invoice_id?: string;
  quickbooks_invoice_number?: string;
};

function emptyToNull(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
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

  const query = String(formData.get("lookup_query") ?? "").trim();
  if (!query) {
    redirect("/cases/new?error=Enter+QuickBooks+customer+or+invoice");
  }

  const invoiceByNumberPromise = supabase
    .from("quickbooks_invoices")
    .select("quickbooks_invoice_id, invoice_number, quickbooks_customer_id, shipping_address")
    .ilike("invoice_number", `%${query}%`)
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
        .select("quickbooks_invoice_id, invoice_number, quickbooks_customer_id, shipping_address")
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
      quickbooks_customer_id: customer?.quickbooks_customer_id ?? invoice?.quickbooks_customer_id ?? "",
      quickbooks_invoice_id: invoice?.quickbooks_invoice_id ?? "",
      quickbooks_invoice_number: invoice?.invoice_number ?? "",
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
      quickbooks_invoice_id: emptyToNull(formData.get("quickbooks_invoice_id")),
      quickbooks_invoice_number: emptyToNull(formData.get("quickbooks_invoice_number")),
      quickbooks_invoice_link: emptyToNull(formData.get("quickbooks_invoice_link")),
      product_model: emptyToNull(formData.get("product_model")),
      serial_number: emptyToNull(formData.get("serial_number")),
      date_of_purchase: emptyToNull(formData.get("date_of_purchase")),
      issue_reported_at: String(formData.get("issue_reported_at") ?? new Date().toISOString()),
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
    summary: `Case ${createdCase.case_number} created`,
    details: { status, priority },
  });

  revalidatePath("/dashboard");
  revalidatePath("/cases");
  redirect(`/cases/${createdCase.id}`);
}
