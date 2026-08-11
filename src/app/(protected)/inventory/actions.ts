"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

function normalizeAliasSku(value: FormDataEntryValue | null) {
  return String(value ?? "").trim().toUpperCase();
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function parseCatalogCsv(input: string) {
  const rows = input.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (rows.length === 0) return [] as Array<{ sku: string; canonicalSku: string; canonicalName: string }>;

  const header = parseCsvLine(rows[0]).map((value) => value.trim().toLowerCase());
  const skuIndex = header.indexOf("sku");
  const canonicalSkuIndex = header.indexOf("canonical_product_sku");
  const canonicalNameIndex = header.indexOf("canonical_name");
  const descriptionIndex = header.indexOf("description_sample");
  const notesIndex = header.indexOf("notes");

  if (skuIndex < 0) {
    throw new Error("CSV must include a sku column.");
  }

  return rows.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const sku = normalizeAliasSku(cells[skuIndex] ?? "");
    const canonicalSku = normalizeAliasSku(cells[canonicalSkuIndex] ?? "") || sku;
    const canonicalName = String(
      cells[canonicalNameIndex]
      ?? cells[descriptionIndex]
      ?? cells[notesIndex]
      ?? canonicalSku,
    ).trim() || canonicalSku;

    return { sku, canonicalSku, canonicalName };
  }).filter((row) => Boolean(row.sku));
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

export async function seedProductCatalogAction(formData: FormData) {
  await requireUser();

  const csvText = String(formData.get("catalog_csv") ?? "").trim();
  if (!csvText) {
    redirect("/inventory?mapError=Paste+CSV+rows+to+seed+the+catalog");
  }

  const supabase = await createClient();

  let rows: Array<{ sku: string; canonicalSku: string; canonicalName: string }>;
  try {
    rows = parseCatalogCsv(csvText);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to parse CSV.";
    redirect(`/inventory?mapError=${encodeURIComponent(message)}`);
  }

  if (rows.length === 0) {
    redirect("/inventory?mapError=No+catalog+rows+found");
  }

  const { data: existingProducts, error: productsError } = await supabase
    .from("products")
    .select("id, sku");

  if (productsError) {
    redirect(`/inventory?mapError=${encodeURIComponent(productsError.message)}`);
  }

  const existingBySku = new Map((existingProducts ?? []).map((product) => [String(product.sku ?? "").trim().toUpperCase(), product.id]));
  const productUpserts = new Map<string, { sku: string; canonical_name: string; description: string | null; status: string }>();
  const aliasUpserts: Array<{ product_id: string; alias: string; source_type: string; source_ref: string }> = [];

  for (const row of rows) {
    if (!existingBySku.has(row.canonicalSku) && !productUpserts.has(row.canonicalSku)) {
      productUpserts.set(row.canonicalSku, {
        sku: row.canonicalSku,
        canonical_name: row.canonicalName,
        description: row.canonicalName,
        status: "Active",
      });
    }

    const canonicalId = existingBySku.get(row.canonicalSku);
    if (canonicalId && row.sku !== row.canonicalSku) {
      aliasUpserts.push({
        product_id: canonicalId,
        alias: row.sku,
        source_type: "import",
        source_ref: "INVENTORY_PAGE_SEED",
      });
    }
  }

  if (productUpserts.size > 0) {
    const { data: createdProducts, error: insertError } = await supabase
      .from("products")
      .upsert(Array.from(productUpserts.values()), { onConflict: "sku" })
      .select("id, sku");

    if (insertError) {
      redirect(`/inventory?mapError=${encodeURIComponent(insertError.message)}`);
    }

    for (const product of createdProducts ?? []) {
      existingBySku.set(String(product.sku ?? "").trim().toUpperCase(), product.id);
    }
  }

  const finalAliasUpserts = rows
    .filter((row) => row.sku !== row.canonicalSku)
    .map((row) => {
      const productId = existingBySku.get(row.canonicalSku);
      if (!productId) return null;

      return {
        product_id: productId,
        alias: row.sku,
        source_type: "import",
        source_ref: "INVENTORY_PAGE_SEED",
      };
    })
    .filter((row): row is { product_id: string; alias: string; source_type: string; source_ref: string } => Boolean(row));

  if (finalAliasUpserts.length > 0) {
    const { error: aliasError } = await supabase
      .from("product_aliases")
      .upsert(finalAliasUpserts, { onConflict: "product_id,alias,source_type" });

    if (aliasError) {
      redirect(`/inventory?mapError=${encodeURIComponent(aliasError.message)}`);
    }
  }

  revalidatePath("/inventory");
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Seeded ${productUpserts.size} products and ${finalAliasUpserts.length} aliases from ${rows.length} rows.`)}`);
}
