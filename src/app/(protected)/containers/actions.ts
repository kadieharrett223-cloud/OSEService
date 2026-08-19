"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { loadContainerReceipt, UNPLANNED_RECEIPT_REF } from "@/lib/containers/container-coverage";
import { computeCoverage } from "@/lib/containers/coverage-math";
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

function parseProductRows(formData: FormData) {
  const skus = formData.getAll("product_sku").map((value) => String(value ?? "").trim());
  const qtyValues = formData.getAll("product_qty").map((value) => String(value ?? "").trim());
  const max = Math.max(skus.length, qtyValues.length);
  const rows: Array<{ sku: string; qty: number }> = [];

  for (let index = 0; index < max; index += 1) {
    const sku = skus[index] ?? "";
    const qtyRaw = qtyValues[index] ?? "";
    if (!sku) continue;

    const qty = Number(qtyRaw || "0");
    if (!Number.isFinite(qty) || qty <= 0) continue;

    rows.push({ sku, qty });
  }

  return rows;
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

  const parsedRows = parseProductRows(formData);
  const parsedLines = parsedRows.length > 0 ? parsedRows : parseProductLines(productsInput);
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

type ReceiptEntry = {
  containerLineId: string | null;
  productId: string;
  receivedQty: number;
  note: string;
};

function parseReceiptPayload(raw: string): ReceiptEntry[] {
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];

    return parsed.entries
      .map((entry) => {
        const value = entry as Record<string, unknown>;
        const productId = typeof value.productId === "string" ? value.productId : "";
        const receivedQty = Number(value.receivedQty);
        if (!isUuid(productId) || !Number.isFinite(receivedQty) || receivedQty < 0) return null;

        return {
          containerLineId: typeof value.containerLineId === "string" && isUuid(value.containerLineId) ? value.containerLineId : null,
          productId,
          receivedQty: Math.floor(receivedQty),
          note: typeof value.note === "string" ? value.note.trim().slice(0, 500) : "",
        } satisfies ReceiptEntry;
      })
      .filter((entry): entry is ReceiptEntry => Boolean(entry));
  } catch {
    return [];
  }
}

/**
 * Records what physically arrived. Planned quantities never create inventory; only the counts
 * entered here do. Re-running is safe: the container status guard and the unique inventory event
 * key prevent double-adding stock.
 */
export async function receiveContainerAction(formData: FormData) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const containerId = String(formData.get("container_id") ?? "").trim();
  const containerNumber = String(formData.get("container_number") ?? "").trim();
  if (!containerId || !isUuid(containerId)) {
    redirect("/containers?error=Invalid+container+reference");
  }

  const entries = parseReceiptPayload(String(formData.get("receipt_payload") ?? ""));
  if (entries.length === 0) {
    redirect(`/containers/${containerId}?error=${encodeURIComponent("Enter at least one received quantity before confirming.")}`);
  }

  const { data: container, error: containerError } = await supabase
    .from("containers")
    .select("id, lifecycle_status")
    .eq("id", containerId)
    .maybeSingle();

  if (containerError || !container) {
    redirect("/containers?error=Container+not+found");
  }

  if (String((container as { lifecycle_status: string | null }).lifecycle_status ?? "").toUpperCase() === "RECEIVED") {
    redirect(`/containers/${containerId}?success=${encodeURIComponent("This container was already received. Inventory was not changed.")}`);
  }

  // Demand is read before any writes so coverage is computed against the counts being confirmed.
  const receipt = await loadContainerReceipt(supabase, containerId);
  const existingLineByProduct = new Map(receipt.lines.map((line) => [line.productId, line]));

  const actualByProduct = new Map<string, number>();
  const noteByProduct = new Map<string, string>();
  for (const entry of entries) {
    actualByProduct.set(entry.productId, (actualByProduct.get(entry.productId) ?? 0) + entry.receivedQty);
    if (entry.note) noteByProduct.set(entry.productId, entry.note);
  }

  for (const entry of entries) {
    const existing = entry.containerLineId
      ? receipt.lines.find((line) => line.id === entry.containerLineId)
      : existingLineByProduct.get(entry.productId);

    if (existing) {
      const totalForProduct = actualByProduct.get(entry.productId) ?? entry.receivedQty;
      const { error: updateError } = await supabase
        .from("container_lines")
        .update({ received_qty: totalForProduct })
        .eq("id", existing.id);

      if (updateError) {
        redirect(`/containers/${containerId}?error=${encodeURIComponent(updateError.message)}`);
      }
      continue;
    }

    // Unplanned arrivals are kept separate from the planned manifest: expected stays zero.
    const { error: insertError } = await supabase.from("container_lines").insert({
      container_id: containerId,
      product_id: entry.productId,
      ordered_qty: 0,
      on_order_qty: 0,
      received_qty: entry.receivedQty,
      source_line_ref: UNPLANNED_RECEIPT_REF,
    });

    if (insertError) {
      redirect(`/containers/${containerId}?error=${encodeURIComponent(insertError.message)}`);
    }
  }

  // Inventory comes from actual counts only.
  for (const [productId, receivedQty] of actualByProduct.entries()) {
    if (receivedQty <= 0) continue;

    const { data: existingRows } = await supabase
      .from("inventory_transactions")
      .select("delta")
      .eq("product_id", productId)
      .eq("bucket", "ON_FLOOR");

    const beforeQty = (existingRows ?? []).reduce((sum, row) => sum + Number((row as { delta: number | null }).delta ?? 0), 0);

    const { error: inventoryError } = await supabase.from("inventory_transactions").insert({
      product_id: productId,
      bucket: "ON_FLOOR",
      delta: receivedQty,
      before_qty: beforeQty,
      after_qty: beforeQty + receivedQty,
      reason: `Container ${containerNumber || "receipt"} received`,
      source_type: "CONTAINER_RECEIVED",
      source_event_key: `CONTAINER_RECEIVED:${containerId}:${productId}`,
      container_id: containerId,
    });

    // A duplicate event key means this receipt already added the stock; anything else is a real failure.
    if (inventoryError && inventoryError.code !== "23505") {
      redirect(`/containers/${containerId}?error=${encodeURIComponent(inventoryError.message)}`);
    }
  }

  const coverage = computeCoverage(receipt.demandByProduct, Object.fromEntries(actualByProduct));
  const lineIdsToUpdate = new Set<string>();
  const orderTimelineSkuMap = new Map<string, Set<string>>();

  for (const row of coverage.rows) {
    if (!row.willMarkInWarehouse) continue;
    lineIdsToUpdate.add(row.lineId);
    if (!row.orderId) continue;
    const skuSet = orderTimelineSkuMap.get(row.orderId) ?? new Set<string>();
    skuSet.add(row.sku);
    orderTimelineSkuMap.set(row.orderId, skuSet);
  }

  const waitingLineCount = coverage.rows.filter((row) => !row.willMarkInWarehouse).length;

  if (lineIdsToUpdate.size > 0) {
    const { error: updateLinesError } = await supabase
      .from("shipping_order_lines")
      .update({ warehouse_status: "IN_WAREHOUSE" })
      .in("id", Array.from(lineIdsToUpdate));

    if (updateLinesError) {
      redirect(`/containers/${containerId}?error=${encodeURIComponent(updateLinesError.message)}`);
    }
  }

  for (const [orderId, skuSet] of orderTimelineSkuMap.entries()) {
    const skuSummary = Array.from(skuSet).join(", ");
    await supabase.from("audit_log").insert({
      entity_type: "shipping_order",
      entity_id: orderId,
      action: "CONTAINER_INVENTORY_MOVED_TO_WAREHOUSE",
      details: {
        container_id: containerId,
        container_number: containerNumber || null,
        message: `Container ${containerNumber || "(unknown)"} received - ${skuSummary} inventory now in warehouse`,
      },
    });
  }

  // Permanent reconciliation record of the variance.
  const variance = Array.from(actualByProduct.entries()).map(([productId, actualQty]) => {
    const planned = existingLineByProduct.get(productId);
    const expectedQty = planned?.expectedQty ?? 0;
    return {
      product_id: productId,
      sku: planned?.sku ?? null,
      expected_qty: expectedQty,
      received_qty: actualQty,
      difference: actualQty - expectedQty,
      unplanned: !planned,
      note: noteByProduct.get(productId) ?? null,
    };
  });

  const expectedTotal = receipt.lines.reduce((sum, line) => sum + line.expectedQty, 0);
  const actualTotal = Array.from(actualByProduct.values()).reduce((sum, qty) => sum + qty, 0);
  const shortTotal = variance.reduce((sum, row) => sum + Math.max(0, row.expected_qty - row.received_qty), 0);
  const extraTotal = variance.reduce((sum, row) => sum + Math.max(0, row.received_qty - row.expected_qty), 0);

  await supabase.from("audit_log").insert({
    entity_type: "container",
    entity_id: containerId,
    action: "CONTAINER_RECEIPT_RECONCILED",
    details: {
      container_number: containerNumber || null,
      expected_units: expectedTotal,
      actual_units: actualTotal,
      short_units: shortTotal,
      extra_units: extraTotal,
      line_count_marked_in_warehouse: lineIdsToUpdate.size,
      line_count_waiting: waitingLineCount,
      variance,
    },
  });

  const { error: containerUpdateError } = await supabase
    .from("containers")
    .update({ lifecycle_status: "RECEIVED" })
    .eq("id", containerId);

  if (containerUpdateError) {
    redirect(`/containers/${containerId}?error=${encodeURIComponent(containerUpdateError.message)}`);
  }

  revalidatePath("/containers");
  revalidatePath(`/containers/${containerId}`);
  revalidatePath("/inventory");
  revalidatePath("/orders");
  revalidatePath("/order-queue");
  revalidatePath("/my-sales");

  redirect(
    `/containers/${containerId}?success=${encodeURIComponent(
      `Receipt recorded. ${actualTotal} unit(s) added to On Floor. ${lineIdsToUpdate.size} line(s) moved to In Warehouse, ${waitingLineCount} still waiting.`,
    )}`,
  );
}

export async function updateContainerArrivalDatesAction(formData: FormData) {
  await requireUser();
  const supabase = getSupabaseAdmin();

  const containerId = String(formData.get("container_id") ?? "").trim();
  if (!isUuid(containerId)) {
    redirect("/containers?error=Invalid+container");
  }

  const portDate = emptyToNull(formData.get("port_date"));
  const etaConfirmedDate = emptyToNull(formData.get("eta_confirmed_date"));
  const etaEstimatedDate = emptyToNull(formData.get("eta_estimated_date"));

  for (const value of [portDate, etaConfirmedDate, etaEstimatedDate]) {
    if (value && Number.isNaN(new Date(value).getTime())) {
      redirect(`/containers/${containerId}?error=${encodeURIComponent("Enter a valid date.")}`);
    }
  }

  const { error } = await supabase
    .from("containers")
    .update({
      port_date: portDate,
      eta_confirmed_date: etaConfirmedDate,
      eta_estimated_date: etaEstimatedDate,
    })
    .eq("id", containerId);

  if (error) {
    redirect(`/containers/${containerId}?error=${encodeURIComponent("Could not update arrival dates.")}`);
  }

  revalidatePath("/containers");
  revalidatePath(`/containers/${containerId}`);
  revalidatePath("/inventory");
  revalidatePath("/dashboard");
  revalidatePath("/orders");

  redirect(`/containers/${containerId}?success=${encodeURIComponent("Arrival dates updated.")}`);
}

