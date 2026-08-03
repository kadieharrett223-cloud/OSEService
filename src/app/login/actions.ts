"use server";

import { redirect } from "next/navigation";
import { createSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export async function signInAction(formData: FormData) {
  const firstName = String(formData.get("first_name") ?? "").trim();
  const accessCode = String(formData.get("access_code") ?? "").trim();
  const configuredAccessCode = (process.env.APP_SHARED_ACCESS_CODE ?? "0017").trim();

  if (!firstName || !accessCode) {
    redirect("/login?error=missing_credentials");
  }

  if (!configuredAccessCode || accessCode !== configuredAccessCode) {
    redirect("/login?error=invalid_access_code");
  }

  const sessionUserId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await createSession(sessionUserId, firstName);

  try {
    const supabase = getSupabaseAdmin();
    await supabase.from("access_login_events").insert({
      access_user_id: null,
      full_name_snapshot: firstName,
      success: true,
    });
  } catch {
    // Ignore login history write failures.
  }

  redirect("/dashboard");
}
