"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

function emptyToNull(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
}

function parseProductLines(raw: string) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
      if (parts.length === 0) {
        return null;
      }

      const sku = parts[0];
      const qtyRaw = parts[1] ?? "1";
      const qty = Number(qtyRaw);

      if (!sku || Number.isNaN(qty) || qty <= 0) {
        return null;
      }

      return { sku, qty };
    })
    .filter((item): item is { sku: string; qty: number } => Boolean(item));
}

export async function createContainerAction(formData: FormData) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const containerNumber = String(formData.get("container_number") ?? "").trim();
  if (!containerNumber) {
    redirect("/containers?error=Container+number+is+required");
  }

  const supplier = emptyToNull(formData.get("supplier"));
  const orderDate = emptyToNull(formData.get("order_date"));
  const enteredDate = emptyToNull(formData.get("entered_date")) ?? orderDate;
  const depositAmount = emptyToNull(formData.get("deposit_amount"));
  const depositDate = emptyToNull(formData.get("deposit_date"));
  const finalPaymentAmount = emptyToNull(formData.get("final_payment_amount"));
  const finalPaymentDate = emptyToNull(formData.get("final_payment_date"));
  const remainingBalance = emptyToNull(formData.get("remaining_balance"));
  const paymentStatus = emptyToNull(formData.get("payment_status")) ?? "Pending";
  const lifecycleStatus = emptyToNull(formData.get("lifecycle_status")) ?? "ORDERED";
  const trackingNumber = emptyToNull(formData.get("tracking_number"));
  const etaEstimatedDate = emptyToNull(formData.get("eta_estimated_date"));
  const etaConfirmedDate = emptyToNull(formData.get("eta_confirmed_date"));
  const notes = emptyToNull(formData.get("notes"));
  const productsInput = String(formData.get("products") ?? "").trim();

  const { data: container, error: containerError } = await supabase
    .from("containers")
    .insert({
      container_number: containerNumber,
      supplier,
      order_date: orderDate,
      entered_date: enteredDate,
      deposit_amount: depositAmount ? Number(depositAmount) : null,
      deposit_date: depositDate,
      final_payment_amount: finalPaymentAmount ? Number(finalPaymentAmount) : null,
      final_payment_date: finalPaymentDate,
      remaining_balance: remainingBalance ? Number(remainingBalance) : null,
      payment_status: paymentStatus,
      lifecycle_status: lifecycleStatus,
      tracking_number: trackingNumber,
      eta_estimated_date: etaEstimatedDate,
      eta_confirmed_date: etaConfirmedDate,
      notes,
    })
    .select("id")
    .single();

  if (containerError || !container?.id) {
    redirect("/containers?error=Could+not+create+container");
  }

  const parsedLines = parseProductLines(productsInput);
  if (parsedLines.length > 0) {
    for (const line of parsedLines) {
      let productId: string | null = null;

      const { data: existingProduct, error: productLookupError } = await supabase
        .from("products")
        .select("id")
        .eq("sku", line.sku)
        .maybeSingle();

      if (!productLookupError && existingProduct?.id) {
        productId = existingProduct.id;
      } else {
        const { data: createdProduct, error: createProductError } = await supabase
          .from("products")
          .insert({
            sku: line.sku,
            canonical_name: line.sku,
            description: "Created from container import",
            status: "Active",
          })
          .select("id")
          .single();

        if (!createProductError && createdProduct?.id) {
          productId = createdProduct.id;
        }
      }

      if (productId) {
        await supabase.from("container_lines").insert({
          container_id: container.id,
          product_id: productId,
          ordered_qty: line.qty,
          received_qty: 0,
          on_order_qty: line.qty,
        });
      }
    }
  }

  revalidatePath("/containers");
  redirect("/containers?success=Container+added");
}
