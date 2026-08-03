"use server";

import { redirect } from "next/navigation";
import { createSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export async function signInAction(formData: FormData) {
  const accessCode = String(formData.get("access_code") ?? "").trim();

  if (!accessCode) {
    redirect("/login?error=missing_access_code");
  }

  if (accessCode !== "0017") {
    redirect("/login?error=invalid_access_code");
  }

  let supabase: ReturnType<typeof getSupabaseAdmin>;
  try {
    supabase = getSupabaseAdmin();
  } catch {
    await createSession("local-0017", "Kadie");
    redirect("/dashboard");
  }

  const { data: accessUser, error } = await supabase
    .from("access_users")
    .select("id, full_name, is_active")
    .eq("access_code", accessCode)
    .maybeSingle();

  if (error || !accessUser || accessUser.is_active !== true) {
    await supabase.from("access_login_events").insert({
      access_user_id: accessUser?.id ?? null,
      full_name_snapshot: accessUser?.full_name ?? null,
      success: false,
    });
    await createSession("local-0017", "Kadie");
    redirect("/dashboard");
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
