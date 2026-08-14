"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clearAdminUnlock, isAdminUnlockedForUser, isValidAdminCode, unlockAdminForUser } from "@/lib/admin-access";
import { requireUser } from "@/lib/auth";
import { recalculateProductQueues } from "@/lib/product-queue";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function normalizeAliasSku(value: FormDataEntryValue | null) {
  return String(value ?? "").trim().toUpperCase();
}

async function requireInventoryAdmin() {
  const user = await requireUser();
  if (!(await isAdminUnlockedForUser(user.id))) {
    redirect("/inventory?mapError=Admin+mode+is+required+for+this+change");
  }
  return user;
}

export async function createProductAliasAction(formData: FormData) {
  await requireUser();

  const aliasSku = normalizeAliasSku(formData.get("alias_sku"));
  const productId = String(formData.get("product_id") ?? "").trim();

  if (!aliasSku || !productId) {
    redirect("/inventory?mapError=Alias+SKU+and+canonical+product+are+required");
  }

  const supabase = await createClient();

  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, sku")
    .eq("id", productId)
    .maybeSingle();

  if (productError || !product?.id) {
    redirect("/inventory?mapError=Selected+product+was+not+found");
  }

  const { error: upsertError } = await supabase
    .from("product_aliases")
    .upsert(
      {
        product_id: product.id,
        alias: aliasSku,
        source_type: "manual",
        source_ref: "INVENTORY_PAGE",
      },
      {
        onConflict: "product_id,alias,source_type",
      },
    );

  if (upsertError) {
    redirect(`/inventory?mapError=${encodeURIComponent(upsertError.message)}`);
  }

  revalidatePath("/inventory");
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Mapped ${aliasSku} to ${product.sku}.`)}`);
}

export async function createProductAction(formData: FormData) {
  await requireUser();

  const sku = normalizeAliasSku(formData.get("sku"));
  const canonicalName = String(formData.get("canonical_name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;

  const supabase = await createClient();

  if (!sku || !canonicalName) {
    redirect("/inventory?mapError=SKU+and+product+name+are+required");
  }

  const { data: existingProduct, error: existingError } = await supabase
    .from("products")
    .select("id")
    .eq("sku", sku)
    .maybeSingle();

  if (existingError) {
    redirect(`/inventory?mapError=${encodeURIComponent(existingError.message)}`);
  }

  if (existingProduct?.id) {
    redirect(`/inventory?mapError=${encodeURIComponent(`${sku} already exists in the product catalog.`)}`);
  }

  const { error: insertError } = await supabase.from("products").insert({
    sku,
    canonical_name: canonicalName,
    description,
    status: "Active",
  });

  if (insertError) {
    redirect(`/inventory?mapError=${encodeURIComponent(insertError.message)}`);
  }

  revalidatePath("/inventory");
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Created ${sku}.`)}`);
}

export async function updateProductDisplayOrderAction(formData: FormData) {
  await requireUser();

  const productIds = String(formData.get("product_ids") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const group = String(formData.get("inventory_group") ?? "").trim();
  const sortOrderRaw = String(formData.get("inventory_sort_order") ?? "").trim();

  if (productIds.length === 0) {
    redirect("/inventory?mapError=Select+a+product+to+reorder");
  }

  if (sortOrderRaw && !/^-?\d+$/.test(sortOrderRaw)) {
    redirect("/inventory?mapError=Display+order+must+be+a+whole+number");
  }

  const supabase = await createClient();

  // Supabase types are not regenerated for migration 202608140003 yet.
  const { error } = await supabase
    .from("products")
    .update({
      inventory_group: group || null,
      inventory_sort_order: sortOrderRaw ? Number(sortOrderRaw) : null,
    } as never)
    .in("id", productIds);

  if (error) {
    redirect(`/inventory?mapError=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/inventory");
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Moved to ${group || "Other / Unsorted"}.`)}`);
}

export async function unlockInventoryAdminAction(formData: FormData) {
  const user = await requireUser();
  const code = String(formData.get("admin_code") ?? "").trim();

  if (!isValidAdminCode(code)) {
    redirect("/inventory?mapError=That+admin+code+is+not+valid");
  }

  await unlockAdminForUser(user.id);
  revalidatePath("/inventory");
  redirect("/inventory?mapMessage=Admin+mode+enabled");
}

export async function lockInventoryAdminAction() {
  await requireUser();
  await clearAdminUnlock();
  revalidatePath("/inventory");
  redirect("/inventory?mapMessage=Admin+mode+turned+off");
}

export async function updateProductTitleAction(formData: FormData) {
  await requireInventoryAdmin();

  const productId = String(formData.get("product_id") ?? "").trim();
  const title = String(formData.get("canonical_name") ?? "").trim();

  if (!productId || !title) {
    redirect("/inventory?mapError=Product+title+is+required");
  }

  const { error } = await getSupabaseAdmin()
    .from("products")
    .update({ canonical_name: title })
    .eq("id", productId);

  if (error) {
    redirect(`/inventory?mapError=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/inventory");
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Renamed to ${title}.`)}`);
}

export async function adjustProductStockAction(formData: FormData) {
  const user = await requireInventoryAdmin();

  const productId = String(formData.get("product_id") ?? "").trim();
  const targetRaw = String(formData.get("on_floor_qty") ?? "").trim();
  const note = String(formData.get("reason") ?? "").trim();

  if (!productId || !/^-?\d+(\.\d+)?$/.test(targetRaw)) {
    redirect("/inventory?mapError=Enter+a+valid+on+floor+quantity");
  }

  const target = Number(targetRaw);
  if (target < 0) {
    redirect("/inventory?mapError=On+floor+quantity+cannot+be+negative");
  }

  if (!note) {
    redirect("/inventory?mapError=A+reason+is+required+to+adjust+stock");
  }

  const supabase = getSupabaseAdmin();

  // Stock is a ledger: record the difference rather than overwriting history.
  const { data: existing, error: readError } = await supabase
    .from("inventory_transactions")
    .select("delta")
    .eq("product_id", productId)
    .eq("bucket", "ON_FLOOR");

  if (readError) {
    redirect(`/inventory?mapError=${encodeURIComponent(readError.message)}`);
  }

  const current = (existing ?? []).reduce((sum, row) => sum + Number(row.delta ?? 0), 0);
  const delta = target - current;

  if (delta === 0) {
    redirect("/inventory?mapMessage=On+floor+quantity+already+matches");
  }

  const { error: insertError } = await supabase.from("inventory_transactions").insert({
    product_id: productId,
    bucket: "ON_FLOOR",
    delta,
    before_qty: current,
    after_qty: target,
    reason: `Manual adjustment by ${user.fullName ?? "admin"}: ${note}`,
    source_type: "MANUAL_ADJUSTMENT",
    source_event_key: `manual:${productId}:${Date.now()}`,
  });

  if (insertError) {
    redirect(`/inventory?mapError=${encodeURIComponent(insertError.message)}`);
  }

  revalidatePath("/inventory");
  redirect(`/inventory?mapMessage=${encodeURIComponent(`On floor set to ${target} (${delta > 0 ? "+" : ""}${delta}).`)}`);
}

export async function moveCustomerQueuePositionAction(formData: FormData) {
  await requireInventoryAdmin();

  const lineId = String(formData.get("line_id") ?? "").trim();
  const positionRaw = String(formData.get("queue_position") ?? "").trim();
  const reason = String(formData.get("queue_position_reason") ?? "").trim();

  if (!lineId || !/^\d+$/.test(positionRaw) || Number(positionRaw) < 1) {
    redirect("/inventory?mapError=Enter+a+queue+position+of+1+or+higher");
  }

  if (!reason) {
    redirect("/inventory?mapError=A+reason+is+required+to+move+a+customer");
  }

  const supabase = getSupabaseAdmin();

  const { data: line, error: lineError } = await supabase
    .from("shipping_order_lines")
    .select("id, product_id")
    .eq("id", lineId)
    .maybeSingle();

  if (lineError || !line?.product_id) {
    redirect(`/inventory?mapError=${encodeURIComponent(lineError?.message ?? "Order line not found")}`);
  }

  const { error: updateError } = await supabase
    .from("shipping_order_lines")
    .update({
      queue_position_override: Number(positionRaw),
      queue_position_override_reason: reason,
      queue_position_override_at: new Date().toISOString(),
    } as never)
    .eq("id", lineId);

  if (updateError) {
    redirect(`/inventory?mapError=${encodeURIComponent(updateError.message)}`);
  }

  await recalculateProductQueues([line.product_id]);

  revalidatePath("/inventory");
  revalidatePath("/orders");
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Moved to position ${positionRaw}.`)}`);
}
