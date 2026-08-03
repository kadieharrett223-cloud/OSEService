"use server";

import crypto from "node:crypto";
import { redirect } from "next/navigation";
import { createSession } from "@/lib/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function generateInternalAccessCode() {
  return `AUTO-${crypto.randomUUID()}`;
}

function isRedirectLikeError(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error
    && typeof (error as { digest?: unknown }).digest === "string"
    && (error as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

function isConnectivityError(message: string | null | undefined) {
  const normalized = String(message ?? "").toLowerCase();
  return normalized.includes("fetch failed") || normalized.includes("network") || normalized.includes("timeout");
}

function redirectForSupabaseError(message: string | null | undefined, fallback: string): never {
  if (isConnectivityError(message)) {
    redirect("/enter-code?error=Unable+to+reach+database");
  }

  redirect(`/enter-code?error=${encodeURIComponent(message ?? fallback)}`);
}

export async function enterCodeAction(formData: FormData) {
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

  try {
    const supabase = getSupabaseAdmin();

    if (accessCode !== expectedCode) {
      await supabase.from("access_login_events").insert({
        success: false,
        full_name_snapshot: fullName || "Unknown",
      });
      redirect("/enter-code?error=Invalid+code");
    }

    let existingUser: { id: string; full_name: string | null; is_active: boolean } | null = null;
    let userId: string | null = null;
    let userName = fullName;

    try {
      const { data, error } = await supabase
        .from("access_users")
        .select("id, full_name, is_active")
        .eq("full_name", fullName)
        .maybeSingle();

      if (error) {
        redirectForSupabaseError(error.message, "Unable to load user");
      }

      existingUser = data as { id: string; full_name: string | null; is_active: boolean } | null;
    } catch {
      existingUser = null;
    }

    if (existingUser && !existingUser.is_active) {
      try {
        await supabase.from("access_login_events").insert({
          success: false,
          full_name_snapshot: existingUser.full_name,
        });
      } catch {
        // Ignore login event errors on disabled users.
      }
      redirect("/enter-code?error=User+is+disabled");
    }

    userId = existingUser?.id ?? null;
    userName = existingUser?.full_name ?? fullName;

    if (!userId) {
      try {
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
          redirectForSupabaseError(createUserError?.message, "Unable to create user");
        }

        userId = createdUser.id;
        userName = createdUser.full_name;
      } catch {
        redirect("/enter-code?error=Unable+to+create+user");
      }
    }

    if (userId) {
      try {
        const [updateUserResult, loginEventResult] = await Promise.all([
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

        if (updateUserResult.error) {
          redirectForSupabaseError(updateUserResult.error.message, "Unable to update login timestamp");
        }

        if (loginEventResult.error) {
          redirectForSupabaseError(loginEventResult.error.message, "Unable to log access event");
        }
      } catch {
        redirect("/enter-code?error=Unable+to+finish+login");
      }
    }

    await createSession(userId!, userName);
    redirect("/dashboard");
  } catch (error) {
    if (isRedirectLikeError(error)) {
      throw error;
    }

    redirect("/enter-code?error=Unable+to+reach+database");
  }
}
