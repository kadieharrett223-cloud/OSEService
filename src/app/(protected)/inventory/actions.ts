"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

function normalizeAliasSku(value: FormDataEntryValue | null) {
  return String(value ?? "").trim().toUpperCase();
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
