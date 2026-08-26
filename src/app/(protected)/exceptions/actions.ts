"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { revalidateCanonicalCustomerQueue } from "@/lib/demand/canonical-customer-queue-cache";
import { revalidateErpHealth } from "@/lib/orders/erp-health-cache";
import { recalculateProductQueues } from "@/lib/product-queue";

export async function rebuildExceptionQueueAction(formData: FormData) {
  await requireUser();
  const productId = String(formData.get("product_id") ?? "").trim();
  if (!productId) return;
  await recalculateProductQueues([productId]);
  revalidateCanonicalCustomerQueue();
  revalidateErpHealth();
  revalidatePath("/exceptions");
  revalidatePath("/inventory");
  revalidatePath("/order-queue");
}
