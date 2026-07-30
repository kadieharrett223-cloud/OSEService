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

function emptyToNull(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
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
