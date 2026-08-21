"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { recalculateProductQueues } from "@/lib/product-queue";
import { revalidateOrdersProjection } from "@/lib/orders/orders-projection-cache";

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

function aliasCandidates(sourceSku: string, sourceDescription: string) {
  const candidates = new Set<string>();
  const sku = sourceSku.trim().toUpperCase();
  if (sku) candidates.add(sku);

  const description = sourceDescription.trim().toUpperCase();
  const skuLikeMatches = description.match(/\b[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g) ?? [];
  for (const match of skuLikeMatches) {
    if (match.length >= 3) candidates.add(match);
  }

  return [...candidates];
}

async function upsertManualAliases(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  productId: string,
  aliases: string[],
  sourceRef: string,
) {
  if (!aliases.length) return;

  const payload = aliases.map((alias) => ({
    product_id: productId,
    alias,
    source_type: "manual",
    source_ref: sourceRef,
  }));

  const { error } = await supabase.from("product_aliases").upsert(payload, { onConflict: "product_id,alias,source_type" });
  if (error) throw error;
}

export async function resolveManualProductMappingAction(formData: FormData) {
  await requireUser();
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
    })
    .eq("id", queueId);

  if (updateError) {
    redirect(`/product-mappings?error=${encodeURIComponent(updateError.message)}`);
  }

  revalidatePath("/product-mappings");
  revalidatePath("/inventory");
  revalidateOrdersProjection();
  revalidatePath("/orders");
  if (returnTo.startsWith("/orders/")) {
    redirect(`${returnTo}?message=Product+mapping+saved`);
  }
  redirect("/product-mappings?message=Mapping+saved.+Affected+orders+remain+pending+reconciliation");
}

export async function createFocusedProductMappingAction(formData: FormData) {
  await requireUser();

  const sourceSku = value(formData, "sourceSku");
  const sourceDescription = value(formData, "sourceDescription");
  const productId = value(formData, "productId");
  const returnTo = value(formData, "returnTo");
  if (!sourceSku || !productId) {
    redirect(`/product-mappings?error=${encodeURIComponent("Select an inventory product")}`);
  }

  const supabase = getSupabaseAdmin();
  try {
    await upsertManualAliases(
      supabase,
      productId,
      aliasCandidates(sourceSku, sourceDescription),
      returnTo || `FOCUSED:${sourceSku}`,
    );
  } catch (error) {
    redirect(`/product-mappings?error=${encodeURIComponent(error instanceof Error ? error.message : "Unable to save aliases")}`);
  }

  const orderMatch = returnTo.match(/^\/orders\/([0-9a-f-]+)/i);
  if (orderMatch) {
    const orderId = orderMatch[1];
    const { data: order } = await supabase
      .from("shipping_orders")
      .select("source_invoice_id")
      .eq("id", orderId)
      .maybeSingle();
    const sourceInvoiceId = order?.source_invoice_id ?? null;
    const { data: invoiceLine } = sourceInvoiceId
      ? await supabase
        .from("qbo_invoice_lines")
        .select("id, qbo_line_id, qbo_sku, ordered_qty, source_description")
        .eq("qbo_invoice_id", sourceInvoiceId)
        .eq("qbo_sku", sourceSku)
        .maybeSingle()
      : { data: null };

    if (invoiceLine) {
      await supabase
        .from("qbo_invoice_lines")
        .update({ product_id: productId })
        .eq("id", invoiceLine.id);
      const { data: existingLine } = await supabase
        .from("shipping_order_lines")
        .select("id")
        .eq("shipping_order_id", orderId)
        .eq("qbo_invoice_line_id", invoiceLine.id)
        .maybeSingle();
      if (!existingLine) {
        const { error: insertError } = await supabase.from("shipping_order_lines").insert({
          shipping_order_id: orderId,
          qbo_invoice_line_id: invoiceLine.id,
          product_id: productId,
          ordered_qty: Number(invoiceLine.ordered_qty ?? 1) || 1,
          approved_qty: Number(invoiceLine.ordered_qty ?? 1) || 1,
          fulfilled_qty: 0,
          cancelled_qty: 0,
          approval_status: "APPROVED",
          warehouse_status: "APPROVED",
          allocation_status: "UNALLOCATED",
          fulfillment_status: "PENDING",
          priority: "NORMAL",
          source_event_key: `QBO_INVOICE_LINE:${sourceInvoiceId}:${invoiceLine.qbo_line_id}`,
          legacy_item_code: invoiceLine.qbo_sku,
        });
        if (insertError && insertError.code !== "23505") {
          redirect(`/product-mappings?error=${encodeURIComponent(insertError.message)}`);
        }
      }
      await recalculateProductQueues([productId]);
    }
  }

  revalidatePath("/product-mappings");
  revalidateOrdersProjection();
  revalidatePath("/orders");
  if (returnTo.startsWith("/orders/")) {
    revalidatePath(returnTo.split("?")[0]);
    redirect(`${returnTo}?message=Product+mapping+saved`);
  }
  redirect("/product-mappings?message=Product+mapping+saved");
}

export async function resolveProductMappingForSkuAction(formData: FormData) {
  await requireUser();
  const sourceSku = value(formData, "sourceSku");
  const sourceDescription = value(formData, "sourceDescription");
  const productId = value(formData, "productId");
  const note = value(formData, "resolutionNote");
  const supabase = getSupabaseAdmin();

  if (!sourceSku || !productId) {
    redirect("/product-mappings?error=Select+a+canonical+product");
  }

  try {
    await upsertManualAliases(
      supabase,
      productId,
      aliasCandidates(sourceSku, sourceDescription),
      `SKU:${sourceSku}`,
    );
  } catch (error) {
    redirect(`/product-mappings?error=${encodeURIComponent(error instanceof Error ? error.message : "Unable to save aliases")}`);
  }

  const queueTable = supabase.from("manual_product_mapping_queue") as any;
  const { error: queueError } = await queueTable
    .update({
      resolved_product_id: productId,
      status: "RESOLVED",
      resolution_note: note || null,
      resolved_at: new Date().toISOString(),
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
  revalidateOrdersProjection();
  revalidatePath("/orders");
  redirect("/product-mappings?message=SKU+mapped+across+all+matching+line+items");
}