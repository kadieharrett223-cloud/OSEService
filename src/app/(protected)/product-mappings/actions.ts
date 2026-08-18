"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { recalculateProductQueues } from "@/lib/product-queue";

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

async function resolveAccessUserId(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  userId: string,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return null;
  }

  const { data } = await supabase.from("access_users").select("id").eq("id", userId).maybeSingle();
  return data?.id ?? null;
}

export async function resolveManualProductMappingAction(formData: FormData) {
  const user = await requireUser();
  const queueId = value(formData, "queueId");
  const productId = value(formData, "productId");
  const note = value(formData, "resolutionNote");
  const returnTo = value(formData, "returnTo");
  const supabase = getSupabaseAdmin();
  const resolvedBy = await resolveAccessUserId(supabase, user.id);
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
      resolved_by: resolvedBy,
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

export async function resolveProductMappingForSkuAction(formData: FormData) {
  const user = await requireUser();
  const sourceSku = value(formData, "sourceSku");
  const productId = value(formData, "productId");
  const note = value(formData, "resolutionNote");
  const supabase = getSupabaseAdmin();
  const resolvedBy = await resolveAccessUserId(supabase, user.id);

  if (!sourceSku || !productId) {
    redirect("/product-mappings?error=Select+a+canonical+product");
  }

  const { error: aliasError } = await supabase.from("product_aliases").upsert({
    product_id: productId,
    alias: sourceSku,
    source_type: "manual",
    source_ref: `SKU:${sourceSku}`,
  }, { onConflict: "product_id,alias,source_type" });
  if (aliasError) redirect(`/product-mappings?error=${encodeURIComponent(aliasError.message)}`);

  const queueTable = supabase.from("manual_product_mapping_queue") as any;
  const { error: queueError } = await queueTable
    .update({
      resolved_product_id: productId,
      status: "RESOLVED",
      resolution_note: note || null,
      resolved_at: new Date().toISOString(),
      resolved_by: resolvedBy,
    })
    .eq("status", "OPEN")
    .eq("source_sku", sourceSku);
  if (queueError) redirect(`/product-mappings?error=${encodeURIComponent(queueError.message)}`);

  const { data: matchingLines, error: lineLookupError } = await supabase
    .from("shipping_order_lines")
    .select("id")
    .eq("legacy_item_code", sourceSku);
  if (lineLookupError) redirect(`/product-mappings?error=${encodeURIComponent(lineLookupError.message)}`);

  if (matchingLines?.length) {
    const { error: lineUpdateError } = await supabase
      .from("shipping_order_lines")
      .update({ product_id: productId })
      .in("id", matchingLines.map((line) => line.id));
    if (lineUpdateError) redirect(`/product-mappings?error=${encodeURIComponent(lineUpdateError.message)}`);
  }

  const { error: invoiceLineError } = await supabase
    .from("qbo_invoice_lines")
    .update({ product_id: productId })
    .eq("qbo_sku", sourceSku);
  if (invoiceLineError) redirect(`/product-mappings?error=${encodeURIComponent(invoiceLineError.message)}`);

  await recalculateProductQueues([productId]);
  revalidatePath("/product-mappings");
  revalidatePath("/inventory");
  revalidatePath("/orders");
  redirect("/product-mappings?message=SKU+mapped+across+all+matching+line+items");
}