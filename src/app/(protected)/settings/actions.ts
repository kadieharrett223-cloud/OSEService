"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function generateInternalAccessCode() {
  return `AUTO-${crypto.randomUUID()}`;
}

export async function createAccessUserAction(formData: FormData) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const fullName = String(formData.get("full_name") ?? "").trim();

  if (!fullName) {
    redirect("/settings?error=Name+is+required");
  }

  const { error } = await supabase.from("access_users").insert({
    full_name: fullName,
    access_code: generateInternalAccessCode(),
    is_active: true,
  });

  if (error) {
    redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/settings");
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
