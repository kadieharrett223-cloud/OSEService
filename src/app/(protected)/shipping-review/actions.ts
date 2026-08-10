"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

async function ensureProductForLine(supabase: Awaited<ReturnType<typeof createClient>>, line: { qbo_sku: string | null; source_description: string | null; product_id: string | null }) {
  if (line.product_id) {
    return line.product_id;
  }

  const candidateSku = line.qbo_sku?.trim() || line.source_description?.trim() || "IMPORTED-PRODUCT";
  const productSku = candidateSku.replace(/\s+/g, "-").slice(0, 80).toUpperCase();
  const canonicalName = line.source_description?.trim() || line.qbo_sku?.trim() || "Imported Product";

  const { data: existingProduct } = await supabase
    .from("products")
    .select("id")
    .eq("sku", productSku)
    .maybeSingle();

  if (existingProduct?.id) {
    return existingProduct.id;
  }

  const { data: createdProduct } = await supabase
    .from("products")
    .insert({
      sku: productSku,
      canonical_name: canonicalName,
      description: "Created from shipping review",
      status: "Active",
    })
    .select("id")
    .single();

  return createdProduct?.id ?? null;
}

export async function approveReviewLineAction(formData: FormData) {
  await requireUser();
  const supabase = await createClient();
  const lineId = String(formData.get("lineId") ?? "").trim();
  if (!lineId) return;

  const { data: line } = await supabase
    .from("qbo_invoice_lines")
    .select("id, qbo_invoice_id, qbo_sku, source_description, product_id, ordered_qty")
    .eq("id", lineId)
    .maybeSingle();

  if (!line) return;

  const productId = await ensureProductForLine(supabase, line);
  if (!productId) return;

  const { data: invoice } = await supabase
    .from("qbo_invoices")
    .select("id, customer_id, invoice_number")
    .eq("id", line.qbo_invoice_id)
    .maybeSingle();

  const { data: existingShippingOrder } = await supabase
    .from("shipping_orders")
    .select("id")
    .eq("source_invoice_id", line.qbo_invoice_id)
    .eq("source_type", "QBO_INVOICE")
    .maybeSingle();

  let shippingOrderId: string | null = existingShippingOrder?.id ?? null;
  if (!shippingOrderId) {
    const { data: createdOrder } = await supabase
      .from("shipping_orders")
      .insert({
        customer_id: invoice?.customer_id ?? null,
        source_invoice_id: line.qbo_invoice_id,
        order_number: invoice?.invoice_number ?? null,
        source_type: "QBO_INVOICE",
        review_status: "APPROVED",
      })
      .select("id")
      .single();
    shippingOrderId = createdOrder?.id ?? null;
  }

  if (shippingOrderId) {
    const { data: existingShippingLine } = await supabase
      .from("shipping_order_lines")
      .select("id")
      .eq("shipping_order_id", shippingOrderId)
      .eq("qbo_invoice_line_id", line.id)
      .maybeSingle();

    const orderedQty = Number(line.ordered_qty ?? 0);

    if (existingShippingLine?.id) {
      await supabase
        .from("shipping_order_lines")
        .update({
          product_id: productId,
          ordered_qty: orderedQty,
          approved_qty: orderedQty,
          approval_status: "APPROVED",
          warehouse_status: "READY_TO_SHIP",
          fulfillment_status: "PENDING",
          approved_at: new Date().toISOString(),
        })
        .eq("id", existingShippingLine.id);
    } else {
      await supabase.from("shipping_order_lines").insert({
        shipping_order_id: shippingOrderId,
        qbo_invoice_line_id: line.id,
        product_id: productId,
        ordered_qty: orderedQty,
        approved_qty: orderedQty,
        fulfillment_status: "PENDING",
        approval_status: "APPROVED",
        warehouse_status: "READY_TO_SHIP",
        approved_at: new Date().toISOString(),
      });
    }
  }

  await supabase.from("qbo_invoice_lines").update({
    approval_status: "APPROVED",
    warehouse_status: "READY_TO_SHIP",
    fulfillment_status: "PENDING",
  }).eq("id", line.id);

  revalidatePath("/shipping-review");
  revalidatePath("/product-queue");
  revalidatePath("/inventory");
  revalidatePath("/my-sales");
}

export async function holdReviewLineAction(formData: FormData) {
  await requireUser();
  const supabase = await createClient();
  const lineId = String(formData.get("lineId") ?? "").trim();
  if (!lineId) return;

  await supabase.from("qbo_invoice_lines").update({
    approval_status: "HOLD",
    warehouse_status: "HOLD",
    fulfillment_status: "PENDING",
  }).eq("id", lineId);

  revalidatePath("/shipping-review");
  revalidatePath("/product-queue");
  revalidatePath("/inventory");
}
