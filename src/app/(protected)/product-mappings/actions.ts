"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type MappingQueueEntry = {
  id: string;
  source_sku: string;
  source_system: string;
  source_record_id: string | null;
};

function value(formData: FormData, key: string) {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

export async function resolveManualProductMappingAction(formData: FormData) {
  const user = await requireUser();
  const queueId = value(formData, "queueId");
  const productId = value(formData, "productId");
  const note = value(formData, "resolutionNote");
  const returnTo = value(formData, "returnTo");
  const supabase = getSupabaseAdmin();
  const queueTable = supabase.from("manual_product_mapping_queue") as any;

  if (!queueId || !productId) {
    redirect("/product-mappings?error=Select+a+canonical+product");
  }

  const { data: rawEntry, error: entryError } = await queueTable
    .select("id, source_sku, source_system, source_record_id")
    .eq("id", queueId)
    .maybeSingle();
  const entry = rawEntry as unknown as MappingQueueEntry | null;

  if (entryError || !entry) {
    redirect(`/product-mappings?error=${encodeURIComponent(entryError?.message ?? "Mapping queue entry not found")}`);
  }

  const { error: aliasError } = await supabase.from("product_aliases").upsert({
    product_id: productId,
    alias: entry.source_sku,
    source_type: "manual",
    source_ref: `${entry.source_system}:${entry.source_record_id ?? entry.id}`,
  }, { onConflict: "product_id,alias,source_type" });

  if (aliasError) {
    redirect(`/product-mappings?error=${encodeURIComponent(aliasError.message)}`);
  }

  const { error: updateError } = await queueTable
    .update({
      resolved_product_id: productId,
      status: "RESOLVED",
      resolution_note: note || null,
      resolved_at: new Date().toISOString(),
      resolved_by: user.id,
    })
    .eq("id", queueId);

  if (updateError) {
    redirect(`/product-mappings?error=${encodeURIComponent(updateError.message)}`);
  }

  revalidatePath("/product-mappings");
  revalidatePath("/inventory");
  revalidatePath("/orders");
  if (returnTo.startsWith("/orders/")) {
    redirect(`${returnTo}?message=Product+mapping+saved`);
  }
  redirect("/product-mappings?message=Mapping+saved.+Affected+orders+remain+pending+reconciliation");
}

export async function createFocusedProductMappingAction(formData: FormData) {
  await requireUser();

  const sourceSku = value(formData, "sourceSku");
  const productId = value(formData, "productId");
  const returnTo = value(formData, "returnTo");
  if (!sourceSku || !productId) {
    redirect(`/product-mappings?error=${encodeURIComponent("Select an inventory product")}`);
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("product_aliases").upsert({
    product_id: productId,
    alias: sourceSku,
    source_type: "manual",
    source_ref: returnTo || `FOCUSED:${sourceSku}`,
  }, { onConflict: "product_id,alias,source_type" });

  if (error) {
    redirect(`/product-mappings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/product-mappings");
  revalidatePath("/orders");
  if (returnTo.startsWith("/orders/")) {
    revalidatePath(returnTo.split("?")[0]);
    redirect(`${returnTo}?message=Product+mapping+saved`);
  }
  redirect("/product-mappings?message=Product+mapping+saved");
}