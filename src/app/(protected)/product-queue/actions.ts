"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

type QueueLineRow = {
  id: string;
  approved_qty: number | null;
  fulfilled_qty: number | null;
};

export async function fulfillQueueLineAction(formData: FormData) {
  await requireUser();
  const supabase = await createClient();
  const lineId = String(formData.get("lineId") ?? "").trim();
  const quantity = Number(formData.get("quantity") ?? 0);
  if (!lineId || Number.isNaN(quantity) || quantity <= 0) return;

  const { data: line } = await supabase
    .from("shipping_order_lines")
    .select("id, approved_qty, fulfilled_qty")
    .eq("id", lineId)
    .maybeSingle();

  const typedLine = line as QueueLineRow | null;
  if (!typedLine) return;

  const nextFulfilled = Math.min(Number(typedLine.approved_qty ?? 0), Number(typedLine.fulfilled_qty ?? 0) + quantity);
  const completed = nextFulfilled >= Number(typedLine.approved_qty ?? 0);

  await supabase.from("shipping_order_lines").update({
    fulfilled_qty: nextFulfilled,
    fulfillment_status: completed ? "FULFILLED" : "PARTIALLY_FULFILLED",
    warehouse_status: completed ? "FULFILLED" : "READY_TO_SHIP",
  } as {
    fulfilled_qty: number;
    fulfillment_status: "FULFILLED" | "PARTIALLY_FULFILLED";
    warehouse_status: "FULFILLED" | "READY_TO_SHIP";
  }).eq("id", typedLine.id);

  await supabase.from("fulfillments").insert({
    shipping_order_line_id: typedLine.id,
    fulfilled_qty: quantity,
    shipment_number: `SHIP-${Date.now()}`,
    source_event_key: `fulfill-${typedLine.id}-${Date.now()}`,
  });

  revalidatePath("/shipping-review");
  revalidatePath("/product-queue");
  revalidatePath("/inventory");
  revalidatePath("/my-sales");
}
