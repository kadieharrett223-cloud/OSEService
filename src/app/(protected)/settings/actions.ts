"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  disconnectQuickbooksConnection,
  syncQuickbooksInvoices,
} from "@/lib/quickbooks/integration";

function generateInternalAccessCode() {
  return `AUTO-${crypto.randomUUID()}`;
}

export async function createAccessUserAction(formData: FormData) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const fullName = String(formData.get("full_name") ?? "").trim();
  const providedAccessCode = String(formData.get("access_code") ?? "").trim();
  const accessCode = providedAccessCode || generateInternalAccessCode();

  if (!fullName) {
    redirect("/settings?error=Name+is+required");
  }

  if (accessCode.length < 4) {
    redirect("/settings?error=Access+code+must+be+at+least+4+characters");
  }

  const { error } = await supabase.from("access_users").insert({
    full_name: fullName,
    access_code: accessCode,
    is_active: true,
  });

  if (error) {
    redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/settings");
  redirect(`/settings?message=${encodeURIComponent(`Access user created. Code: ${accessCode}`)}`);
}

export async function setAccessUserActiveAction(formData: FormData) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const userId = String(formData.get("user_id") ?? "").trim();
  const nextActive = String(formData.get("is_active") ?? "false") === "true";

  if (!userId) {
    redirect("/settings?error=Missing+user");
  }

  const { error } = await supabase
    .from("access_users")
    .update({ is_active: nextActive })
    .eq("id", userId);

  if (error) {
    redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/settings");
}

export async function connectQuickbooksAction() {
  await requireUser();
  redirect("/api/integrations/quickbooks/connect");
}

export async function syncQuickbooksAction() {
  await requireUser();

  try {
    const result = await syncQuickbooksInvoices();
    revalidatePath("/");
    revalidatePath("/settings");
    revalidatePath("/cases/new");
    redirect(`/settings?message=${encodeURIComponent(`QuickBooks sync complete: ${result.invoiceCount} invoices, ${result.customerCount} customers.`)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "QuickBooks sync failed.";
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }
}

export async function disconnectQuickbooksAction() {
  await requireUser();

  try {
    await disconnectQuickbooksConnection();
    revalidatePath("/");
    revalidatePath("/settings");
    redirect("/settings?message=QuickBooks+disconnected");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to disconnect QuickBooks.";
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }
}
