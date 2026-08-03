"use server";

import { redirect } from "next/navigation";
import { createSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export async function signInAction(formData: FormData) {
  const accessCode = String(formData.get("access_code") ?? "").trim();
  const configuredAccessCode = (process.env.APP_SHARED_ACCESS_CODE ?? "0017").trim();

  if (!accessCode) {
    redirect("/login?error=missing_access_code");
  }

  if (!configuredAccessCode || accessCode !== configuredAccessCode) {
    redirect("/login?error=invalid_access_code");
  }

  const supabase = getSupabaseAdmin();

  const { data: accessUser, error } = await supabase
    .from("access_users")
    .select("id, full_name, is_active")
    .eq("access_code", accessCode)
    .maybeSingle();

  if (error || !accessUser || accessUser.is_active !== true) {
    try {
      await supabase.from("access_login_events").insert({
        access_user_id: accessUser?.id ?? null,
        full_name_snapshot: accessUser?.full_name ?? null,
        success: false,
      });
    } catch {
      // Ignore login history write failures.
    }
    redirect("/login?error=invalid_access_code");
  }

  await supabase
    .from("access_users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", accessUser.id);

  await supabase.from("access_login_events").insert({
    access_user_id: accessUser.id,
    full_name_snapshot: accessUser.full_name,
    success: true,
  });

  await createSession(accessUser.id, accessUser.full_name);
  redirect("/dashboard");
}
