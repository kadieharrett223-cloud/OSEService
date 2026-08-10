"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  clearAdminUnlock,
  isAdminUnlockedForUser,
  isValidAdminCode,
  unlockAdminForUser,
} from "@/lib/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  disconnectQuickbooksConnection,
  syncQuickbooksInvoices,
} from "@/lib/quickbooks/integration";

function generateInternalAccessCode() {
  return `AUTO-${crypto.randomUUID()}`;
}

async function requireSettingsAdmin() {
  const user = await requireUser();
  const unlocked = await isAdminUnlockedForUser(user.id);
  if (!unlocked) {
    redirect("/settings?error=Admin+code+required");
  }
  return user;
}

export async function unlockSettingsAdminAction(formData: FormData) {
  const user = await requireUser();
  const code = String(formData.get("admin_code") ?? "").trim();

  if (!isValidAdminCode(code)) {
    redirect("/settings?error=Invalid+admin+code");
  }

  await unlockAdminForUser(user.id);
  redirect("/settings?message=Admin+access+enabled");
}

export async function lockSettingsAdminAction() {
  await requireUser();
  await clearAdminUnlock();
  redirect("/settings?message=Admin+access+locked");
}

export async function createAccessUserAction(formData: FormData) {
  await requireSettingsAdmin();
  const supabase = getSupabaseAdmin();

  const fullName = String(formData.get("full_name") ?? "").trim();
  const accessCode = generateInternalAccessCode();

  if (!fullName) {
    redirect("/settings?error=Name+is+required");
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
  redirect("/settings?message=Access+user+created");
}

export async function setAccessUserActiveAction(formData: FormData) {
  await requireSettingsAdmin();
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
  await requireSettingsAdmin();
  redirect("/api/integrations/quickbooks/connect");
}

export async function syncQuickbooksAction() {
  await requireSettingsAdmin();

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
  await requireSettingsAdmin();

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
