"use server";

import { redirect } from "next/navigation";
import { createSession } from "@/lib/session";

export async function signInAction(formData: FormData) {
  void formData;

  const userId = process.env.LOCAL_DEV_USER_ID ?? "00000000-0000-0000-0000-000000000000";
  const userName = process.env.LOCAL_DEV_USER_NAME ?? "Sandbox User";
  await createSession(userId, userName);
  redirect("/dashboard");
}
