"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { clearAdminUnlock, isAdminUnlockedForUser, isValidAdminCode, unlockAdminForUser } from "@/lib/admin-access";
import { requireUser } from "@/lib/auth";
import { revalidateCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-cache";
import { revalidateInventoryReadModelCache } from "@/lib/inventory/inventory-read-cache";
import { revalidateOrdersProjection } from "@/lib/orders/orders-projection-cache";
import { recalculateProductQueues } from "@/lib/product-queue";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { fetchQueuePages } from "@/lib/demand/queue-query-pages";
import { getCachedOldErpProductIdentityBySourceRecordId } from "@/lib/products/old-erp-product-identity";
import { stockEditContext } from "@/lib/inventory/stock-edit-context";

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

function revalidateInventoryReadModel() {
  revalidateInventoryReadModelCache();
  revalidateCanonicalCustomerQueue();
  revalidatePath("/inventory");
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

  revalidateInventoryReadModel();
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Mapped ${aliasSku} to ${product.sku}.`)}`);
}

export async function createProductAction(formData: FormData) {
  const user = await requireUser();

  const sku = normalizeAliasSku(formData.get("sku"));
  const canonicalName = String(formData.get("canonical_name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const onFloorQtyRaw = String(formData.get("on_floor_qty") ?? "0").trim();
  const inventoryGroup = String(formData.get("inventory_group") ?? "").trim() || null;
  const sortOrderRaw = String(formData.get("inventory_sort_order") ?? "").trim();

  const supabase = getSupabaseAdmin();

  if (!sku || !canonicalName) {
    redirect("/inventory?mapError=SKU+and+product+name+are+required");
  }

  if (!/^\d+(\.\d+)?$/.test(onFloorQtyRaw) || Number(onFloorQtyRaw) < 0) {
    redirect("/inventory?mapError=Starting+on+floor+quantity+must+be+zero+or+greater");
  }

  if (sortOrderRaw && !/^-?\d+$/.test(sortOrderRaw)) {
    redirect("/inventory?mapError=Display+order+must+be+a+whole+number");
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

  const { data: createdProduct, error: insertError } = await supabase.from("products").insert({
    sku,
    canonical_name: canonicalName,
    description,
    status: "Active",
    inventory_group: inventoryGroup,
    inventory_sort_order: sortOrderRaw ? Number(sortOrderRaw) : null,
  } as never).select("id").single();

  if (insertError) {
    redirect(`/inventory?mapError=${encodeURIComponent(insertError.message)}`);
  }

  const startingQty = Number(onFloorQtyRaw);
  if (startingQty > 0 && createdProduct?.id) {
    const { error: transactionError } = await getSupabaseAdmin().from("inventory_transactions").insert({
      product_id: createdProduct.id,
      bucket: "ON_FLOOR",
      delta: startingQty,
      before_qty: 0,
      after_qty: startingQty,
      reason: `Initial quantity entered by ${user.fullName ?? "user"}`,
      source_type: "ADJUSTMENT",
      source_event_key: `product-create:${createdProduct.id}`,
    });

    if (transactionError) {
      redirect(`/inventory?mapError=${encodeURIComponent(`Product created, but starting quantity was not saved: ${transactionError.message}`)}`);
    }
  }

  revalidateInventoryReadModel();
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

  const supabase = getSupabaseAdmin();

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

  revalidateInventoryReadModel();
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Moved to ${group || "Other / Unsorted"}.`)}`);
}

export async function unlockInventoryAdminAction(formData: FormData) {
  const user = await requireUser();
  const code = String(formData.get("admin_code") ?? "").trim();

  if (!isValidAdminCode(code)) {
    redirect("/inventory?mapError=That+admin+code+is+not+valid");
  }

  await unlockAdminForUser(user.id);
  // Cookie changes refresh this user's UI; no inventory data changed.
  redirect("/inventory?mapMessage=Admin+mode+enabled");
}

export async function lockInventoryAdminAction() {
  await requireUser();
  await clearAdminUnlock();
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

  revalidateInventoryReadModel();
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Renamed to ${title}.`)}`);
}

/**
 * Permanently removes a catalog product only when it has never participated in
 * operational data. This deliberately refuses to delete a product with any
 * order, QBO, container, allocation, or ledger reference so a catalog cleanup
 * can never rewrite stock, fulfillment, or historical records.
 */
export async function deleteUnusedProductAction(formData: FormData) {
  const user = await requireUser();
  const productId = String(formData.get("product_id") ?? "").trim();

  if (!productId) {
    redirect("/inventory?mapError=Product+is+required");
  }

  const supabase = getSupabaseAdmin();
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id,sku,canonical_name")
    .eq("id", productId)
    .maybeSingle();

  if (productError || !product) {
    redirect(`/inventory?mapError=${encodeURIComponent(productError?.message ?? "Product not found")}`);
  }

  const referenceTables = [
    "qbo_invoice_lines",
    "shipping_order_lines",
    "container_lines",
    "inventory_transactions",
    "inventory_allocations",
  ] as const;
  const references = await Promise.all(referenceTables.map(async (table) => {
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("product_id", product.id);
    if (error) throw error;
    return { table, count: count ?? 0 };
  }));
  const usedBy = references.filter((reference) => reference.count > 0);
  if (usedBy.length > 0) {
    redirect(`/inventory?mapError=${encodeURIComponent(`${product.sku} cannot be deleted because it is referenced by ${usedBy.map((reference) => `${reference.count} ${reference.table}`).join(", ")}. Historical and operational product records are never deleted by catalog cleanup.`)}`);
  }

  const { error: auditError } = await supabase.from("audit_log").insert({
    entity_type: "PRODUCT",
    entity_id: product.id,
    action: "PRODUCT_DELETED_UNUSED",
    actor_id: user.id,
    details: {
      sku: product.sku,
      canonical_name: product.canonical_name,
      reason: "Confirmed non-existent product catalog cleanup",
    },
  });
  if (auditError) {
    redirect(`/inventory?mapError=${encodeURIComponent(auditError.message)}`);
  }

  const { error: deleteError } = await supabase.from("products").delete().eq("id", product.id);
  if (deleteError) {
    redirect(`/inventory?mapError=${encodeURIComponent(deleteError.message)}`);
  }

  revalidateInventoryReadModel();
  revalidateOrdersProjection();
  revalidatePath("/product-mappings");
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Permanently deleted unused product ${product.sku}. No stock, shipment, allocation, or order records were changed.`)}`);
}

export async function adjustProductStockAction(formData: FormData) {
  const user = await requireInventoryAdmin();

  const sku = String(formData.get("stock_sku") ?? "").trim();
  const requestId = String(formData.get("request_id") ?? "").trim();
  const targetRaw = String(formData.get("on_floor_qty") ?? "").trim();
  const expectedRaw = String(formData.get("expected_on_floor_qty") ?? "").trim();
  const note = String(formData.get("reason") ?? "").trim();

  if (!sku || !/^[0-9a-f-]{36}$/i.test(requestId) || !/^\d+$/.test(targetRaw) || !/^-?\d+(\.\d+)?$/.test(expectedRaw)) {
    redirect("/inventory?mapError=Enter+a+valid+on+floor+quantity");
  }

  const target = Number(targetRaw);
  if (!Number.isSafeInteger(target) || target < 0) {
    redirect("/inventory?mapError=On+floor+quantity+cannot+be+negative");
  }

  if (!note) {
    redirect("/inventory?mapError=A+reason+is+required+to+adjust+stock");
  }

  const supabase = getSupabaseAdmin();
  let context;
  let transactions;
  try {
    const [products, aliases, archive, ledger] = await Promise.all([
      fetchQueuePages((from, to) => supabase.from("products").select("id,sku,canonical_name,source_record_id").neq("status", "Inactive").order("id").range(from, to)),
      fetchQueuePages((from, to) => supabase.from("product_aliases").select("product_id,alias").order("product_id").order("alias").range(from, to)),
      getCachedOldErpProductIdentityBySourceRecordId(),
      fetchQueuePages((from, to) => supabase.from("inventory_transactions").select("product_id,source_type").eq("bucket", "ON_FLOOR").order("id").range(from, to)),
    ]);
    transactions = ledger;
    const productRows = products as unknown as Array<{ id: string; sku: string | null; canonical_name: string | null; source_record_id: string | null }>;
    context = stockEditContext(productRows.filter(p => p.sku?.trim().toUpperCase() !== "TEST"), aliases, archive, ledger, sku);
  } catch (error) {
    redirect(`/inventory?mapError=${encodeURIComponent(error instanceof Error ? error.message : "Could not verify stock records")}`);
  }
  // Never trust the browser to choose different ledger identities from the displayed row.
  if (!context.targetId || String(formData.get("stock_product_ids")) !== JSON.stringify(context.ownerIds)) {
    revalidateInventoryReadModel();
    redirect("/inventory?mapError=Stock+identity+changed.+Refresh+and+review+the+count+before+saving.");
  }
  // Atomic fresh-count check + audit + one delta. RPC is executable only by service_role.
  const { data, error } = await (supabase as any).rpc("recount_inventory_stock_group", {
    p_group_ids: context.groupIds, p_owner_ids: context.ownerIds, p_target_id: context.targetId,
    p_expected: Number(expectedRaw), p_target: target,
    p_snapshot_count: transactions.filter(t => context.groupIds.includes(t.product_id ?? "")).length,
    p_request_id: requestId, p_actor_name: user.fullName ?? "admin", p_actor_id: user.id, p_reason: note,
  });
  if (error) redirect(`/inventory?mapError=${encodeURIComponent(error.message)}`);
  const result = data as { outcome: string; delta: number };
  if (result.outcome === "STALE_COUNT") {
    revalidateInventoryReadModel();
    redirect("/inventory?mapError=Stock+count+changed+or+the+editor+is+outdated.+Refresh+and+review+the+count+before+saving.+Attempt+recorded+in+audit.");
  }
  if (result.outcome === "ALREADY_MATCHES") {
    revalidatePath("/inventory/audit");
    redirect("/inventory?mapMessage=On+floor+quantity+already+matches.+No+stock+changed%3B+attempt+recorded+in+audit.");
  }
  revalidateInventoryReadModel();
  redirect(`/inventory?mapMessage=${encodeURIComponent(`On floor set to ${target} (${result.delta > 0 ? "+" : ""}${result.delta}).`)}`);
}

export async function moveCustomerQueuePositionAction(formData: FormData) {
  await requireInventoryAdmin();

  const lineId = String(formData.get("line_id") ?? "").trim();
  const direction = String(formData.get("direction") ?? "").trim().toLowerCase();
  const reason = String(formData.get("queue_position_reason") ?? "").trim();

  if (!lineId || !["up", "down"].includes(direction)) {
    redirect("/inventory?mapError=Choose+an+up+or+down+queue+move");
  }

  if (!reason) {
    redirect("/inventory?mapError=A+reason+is+required+to+move+a+customer");
  }

  const supabase = getSupabaseAdmin();

  const { data: line, error: lineError } = await supabase
    .from("shipping_order_lines")
    .select("id, product_id, queue_position_start, approved_qty, fulfilled_qty, approval_status, fulfillment_status")
    .eq("id", lineId)
    .maybeSingle();

  if (lineError || !line?.product_id) {
    redirect(`/inventory?mapError=${encodeURIComponent(lineError?.message ?? "Order line not found")}`);
  }

  const { data: productLines, error: productLinesError } = await supabase
    .from("shipping_order_lines")
    .select("id, queue_position_start, queue_position_count, approved_qty, fulfilled_qty, approval_status, fulfillment_status")
    .eq("product_id", line.product_id)
    .in("approval_status", ["APPROVED", "PARTIAL"])
    .neq("fulfillment_status", "FULFILLED")
    .neq("fulfillment_status", "CANCELLED")
    .order("queue_position_start", { ascending: true, nullsFirst: false });

  if (productLinesError) redirect(`/inventory?mapError=${encodeURIComponent(productLinesError.message)}`);

  const activeLines = (productLines ?? []).filter((candidate) =>
    Math.max(0, Number(candidate.approved_qty ?? 0) - Number(candidate.fulfilled_qty ?? 0)) > 0
    && candidate.queue_position_start != null,
  );
  const currentIndex = activeLines.findIndex((candidate) => candidate.id === lineId);
  const neighborIndex = currentIndex + (direction === "up" ? -1 : 1);
  const neighbor = activeLines[neighborIndex];
  if (currentIndex < 0 || !neighbor) {
    redirect(`/inventory?mapError=${direction === "up" ? "This+customer+is+already+first" : "This+customer+is+already+last"}`);
  }

  const current = activeLines[currentIndex]!;
  const currentStart = Number(current.queue_position_start ?? 0);
  const currentUnits = Math.max(0, Number(current.approved_qty ?? 0) - Number(current.fulfilled_qty ?? 0));
  const neighborStart = Number(neighbor.queue_position_start ?? 0);
  const neighborTarget = direction === "up" ? neighborStart + currentUnits : currentStart;
  const now = new Date().toISOString();
  const updates = await Promise.all([
    supabase.from("shipping_order_lines").update({
      queue_position_override: neighborStart,
      queue_position_override_reason: reason,
      queue_position_override_at: now,
    } as never).eq("id", lineId),
    supabase.from("shipping_order_lines").update({
      queue_position_override: neighborTarget,
      queue_position_override_reason: reason,
      queue_position_override_at: now,
    } as never).eq("id", neighbor.id),
  ]);
  const updateError = updates.find((result) => result.error)?.error;

  if (updateError) {
    redirect(`/inventory?mapError=${encodeURIComponent(updateError.message)}`);
  }

  await recalculateProductQueues([line.product_id]);

  revalidateInventoryReadModel();
  revalidateOrdersProjection();
  revalidatePath("/orders");
  redirect(`/inventory?mapMessage=${encodeURIComponent(`Moved ${direction === "up" ? "up" : "down"} one position.`)}`);
}
