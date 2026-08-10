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

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

type ContainerLineAvailability = {
  product_id: string | null;
  ordered_qty: number | null;
  on_order_qty: number | null;
  received_qty: number | null;
};

type ContainerAllocationRow = {
  id: string;
  quantity: number | null;
  product_id: string | null;
  shipping_order_line_id: string | null;
  shipping_order_lines?: {
    id: string;
    approved_qty: number | null;
    fulfilled_qty: number | null;
    warehouse_status: string | null;
    queue_position_start: number | null;
  } | null;
};

export async function acceptContainerToWarehouseAction(formData: FormData) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const containerId = String(formData.get("container_id") ?? "").trim();
  if (!containerId || !isUuid(containerId)) {
    redirect("/containers?error=Invalid+container+reference");
  }

  const { data: container, error: containerError } = await supabase
    .from("containers")
    .select("id, lifecycle_status")
    .eq("id", containerId)
    .maybeSingle();

  if (containerError || !container) {
    redirect("/containers?error=Container+not+found");
  }

  const { data: containerLines, error: containerLinesError } = await supabase
    .from("container_lines")
    .select("product_id, ordered_qty, on_order_qty, received_qty")
    .eq("container_id", containerId);

  if (containerLinesError) {
    redirect(`/containers/${containerId}?error=${encodeURIComponent(containerLinesError.message)}`);
  }

  const typedContainerLines = (containerLines ?? []) as ContainerLineAvailability[];
  const hasExplicitReceipts = typedContainerLines.some((line) => Number(line.received_qty ?? 0) > 0);

  const availableByProduct = new Map<string, number>();
  for (const line of typedContainerLines) {
    if (!line.product_id) continue;
    const received = Number(line.received_qty ?? 0);
    const fallback = Number(line.ordered_qty ?? line.on_order_qty ?? 0);
    const available = hasExplicitReceipts ? Math.max(received, 0) : Math.max(fallback, 0);
    if (available <= 0) continue;
    availableByProduct.set(line.product_id, (availableByProduct.get(line.product_id) ?? 0) + available);
  }

  const { data: allocationRows, error: allocationError } = await supabase
    .from("inventory_allocations")
    .select(`
      id,
      quantity,
      product_id,
      shipping_order_line_id,
      shipping_order_lines (
        id,
        approved_qty,
        fulfilled_qty,
        warehouse_status,
        queue_position_start
      )
    `)
    .eq("container_id", containerId)
    .eq("source_type", "CONTAINER")
    .eq("allocation_status", "ALLOCATED");

  if (allocationError) {
    redirect(`/containers/${containerId}?error=${encodeURIComponent(allocationError.message)}`);
  }

  const typedAllocations = (allocationRows ?? []) as ContainerAllocationRow[];
  const groupedByProduct = new Map<string, ContainerAllocationRow[]>();

  for (const allocation of typedAllocations) {
    if (!allocation.product_id || !allocation.shipping_order_lines?.id) continue;
    const rows = groupedByProduct.get(allocation.product_id) ?? [];
    rows.push(allocation);
    groupedByProduct.set(allocation.product_id, rows);
  }

  const lineIdsToUpdate = new Set<string>();

  for (const [productId, allocations] of groupedByProduct.entries()) {
    let available = availableByProduct.get(productId) ?? 0;
    if (available <= 0) continue;

    const sorted = [...allocations].sort((a, b) => {
      const aPos = a.shipping_order_lines?.queue_position_start ?? Number.MAX_SAFE_INTEGER;
      const bPos = b.shipping_order_lines?.queue_position_start ?? Number.MAX_SAFE_INTEGER;
      return aPos - bPos;
    });

    for (const allocation of sorted) {
      const line = allocation.shipping_order_lines;
      if (!line?.id) continue;

      if (["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP", "PARTIALLY_FULFILLED", "FULFILLED"].includes(line.warehouse_status ?? "")) {
        continue;
      }

      const remainingQty = Math.max(0, Number(line.approved_qty ?? 0) - Number(line.fulfilled_qty ?? 0));
      if (remainingQty <= 0) continue;

      const allocatedQty = Math.max(0, Number(allocation.quantity ?? 0));
      const requiredQty = Math.min(remainingQty, allocatedQty);
      if (requiredQty <= 0) continue;

      if (available >= requiredQty) {
        lineIdsToUpdate.add(line.id);
        available -= requiredQty;
      }
    }
  }

  if (lineIdsToUpdate.size > 0) {
    const { error: updateLinesError } = await supabase
      .from("shipping_order_lines")
      .update({ warehouse_status: "IN_WAREHOUSE" })
      .in("id", Array.from(lineIdsToUpdate));

    if (updateLinesError) {
      redirect(`/containers/${containerId}?error=${encodeURIComponent(updateLinesError.message)}`);
    }
  }

  const { error: containerUpdateError } = await supabase
    .from("containers")
    .update({ lifecycle_status: "RECEIVED" })
    .eq("id", containerId);

  if (containerUpdateError) {
    redirect(`/containers/${containerId}?error=${encodeURIComponent(containerUpdateError.message)}`);
  }

  await supabase.from("audit_log").insert({
    entity_type: "container",
    entity_id: containerId,
    action: "CONTAINER_ACCEPTED_INTO_WAREHOUSE",
    details: {
      line_count_marked_in_warehouse: lineIdsToUpdate.size,
      used_explicit_received_qty: hasExplicitReceipts,
    },
  });

  revalidatePath("/containers");
  revalidatePath(`/containers/${containerId}`);
  revalidatePath("/inventory");
  revalidatePath("/orders");
  revalidatePath("/order-queue");
  revalidatePath("/my-sales");

  redirect(`/containers/${containerId}?success=${encodeURIComponent(`Container accepted. ${lineIdsToUpdate.size} line(s) moved to In Warehouse.`)}`);
}
