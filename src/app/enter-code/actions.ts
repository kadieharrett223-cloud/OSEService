"use server";

import crypto from "node:crypto";
import { redirect } from "next/navigation";
import { createSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function generateInternalAccessCode() {
  return `AUTO-${crypto.randomUUID()}`;
}

export async function enterCodeAction(formData: FormData) {
  const supabase = getSupabaseAdmin();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const accessCodeInput = String(formData.get("access_code") ?? "").trim();
  const configuredSharedCode = String(process.env.APP_SHARED_ACCESS_CODE ?? "").trim();
  const accessCode = accessCodeInput.toUpperCase();
  const expectedCode = configuredSharedCode.toUpperCase();

  if (!fullName || !accessCode) {
    redirect("/enter-code?error=Name+and+code+are+required");
  }

  if (!expectedCode) {
    redirect("/enter-code?error=Shared+access+code+is+not+configured");
  }

  if (accessCode !== expectedCode) {
    await supabase.from("access_login_events").insert({
      success: false,
      full_name_snapshot: fullName || "Unknown",
    });
    redirect("/enter-code?error=Invalid+code");
  }

  const { data: existingUser } = await supabase
    .from("access_users")
    .select("id, full_name, is_active")
    .eq("full_name", fullName)
    .maybeSingle();

  if (existingUser && !existingUser.is_active) {
    await supabase.from("access_login_events").insert({
      success: false,
      full_name_snapshot: existingUser.full_name,
    });
    redirect("/enter-code?error=User+is+disabled");
  }

  let userId = existingUser?.id;
  let userName = existingUser?.full_name ?? fullName;

  if (!userId) {
    const { data: createdUser, error: createUserError } = await supabase
      .from("access_users")
      .insert({
        full_name: fullName,
        access_code: generateInternalAccessCode(),
        is_active: true,
        last_login_at: new Date().toISOString(),
      })
      .select("id, full_name")
      .single();

    if (createUserError || !createdUser) {
      redirect(`/enter-code?error=${encodeURIComponent(createUserError?.message ?? "Unable to create user")}`);
    }

    userId = createdUser.id;
    userName = createdUser.full_name;
  }

  await Promise.all([
    supabase
      .from("access_users")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", userId),
    supabase.from("access_login_events").insert({
      access_user_id: userId,
      full_name_snapshot: userName,
      success: true,
    }),
  ]);

  await createSession(userId, userName);
  redirect("/dashboard");
}
