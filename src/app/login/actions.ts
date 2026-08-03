"use server";

import { redirect } from "next/navigation";
import { createSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function normalizeName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export async function signInAction(formData: FormData) {
  const fullName = String(formData.get("full_name") ?? "").trim();
  const accessCode = String(formData.get("access_code") ?? "").trim();

  if (!fullName || !accessCode) {
    redirect("/login?error=missing_credentials");
  }

  let supabase: ReturnType<typeof getSupabaseAdmin>;
  try {
    supabase = getSupabaseAdmin();
  } catch {
    redirect("/login?error=missing_live_config");
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
    redirect("/login?error=invalid_credentials");
  }

  const normalizedProvidedName = normalizeName(fullName);
  const normalizedStoredName = normalizeName(accessUser.full_name);
  const providedMatchesStored = normalizedProvidedName === normalizedStoredName
    || normalizedStoredName.startsWith(`${normalizedProvidedName} `)
    || normalizedStoredName === normalizedProvidedName;

  if (!providedMatchesStored) {
    await supabase.from("access_login_events").insert({
      access_user_id: accessUser.id,
      full_name_snapshot: accessUser.full_name,
      success: false,
    });
    redirect("/login?error=invalid_credentials");
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
