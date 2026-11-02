import type { getSupabaseAdmin } from "@/lib/supabase/admin";
import { fetchQueuePages } from "@/lib/demand/queue-query-pages";

/** A stock total must include every movement, including events beyond the API row cap. */
export function loadInventoryStockHistory(db: ReturnType<typeof getSupabaseAdmin>) {
  return fetchQueuePages((from, to) => db.from("inventory_transactions")
    .select("product_id, bucket, delta, source_type").order("id").range(from, to), 1, 1000);
}
