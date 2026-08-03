"use server";

import { redirect } from "next/navigation";

export async function enterCodeAction(_formData: FormData) {
  redirect("/login");
}
