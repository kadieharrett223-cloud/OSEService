"use server";

import { redirect } from "next/navigation";

export async function signInAction(formData: FormData) {
  void formData;
  redirect("/enter-code");
}
