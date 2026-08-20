"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { recalculateProductQueues } from "@/lib/product-queue";

export async function rebuildExceptionQueueAction(formData: FormData) {
  await requireUser();
  const productId = String(formData.get("product_id") ?? "").trim();
  if (!productId) return;
  await recalculateProductQueues([productId]);
  revalidatePath("/exceptions");
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
}
