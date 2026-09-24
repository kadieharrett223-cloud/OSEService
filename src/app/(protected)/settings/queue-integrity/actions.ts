"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { recalculateProductQueuePositions } from "@/lib/product-queue";

export async function persistAuditedQueuePositionsAction(formData: FormData) {
  await requireUser();
  const productIds = String(formData.get("product_ids") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));

  const result = await recalculateProductQueuePositions(productIds);
  revalidatePath("/inventory");
  revalidatePath("/orders");
  revalidatePath("/orders/[id]", "page");
  revalidatePath("/settings/queue-integrity");
  redirect(`/settings/queue-integrity?run=1&message=${encodeURIComponent(`Saved current Customer List positions for ${result.linesUpdated} line(s) across ${result.productsUpdated} product record(s). No inventory, mapping, allocation, fulfillment, shipment, or order data was changed.`)}`);
}
