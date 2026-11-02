import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { containerInventoryOptions } from "./product-selection";
import { fetchQueuePages } from "@/lib/demand/queue-query-pages";

/** One selectable identity per physical stock route; never load raw QBO copies. */
export async function loadContainerProductOptions() {
  const supabase = getSupabaseAdmin();
  const [products, routes] = await Promise.all([
    fetchQueuePages((from, to) => supabase.from("products").select("id,sku,canonical_name,status").order("id").range(from, to)),
    fetchQueuePages((from, to) => supabase.from("inventory_stock_routes").select("product_id,stock_product_id,operational_key").order("product_id").range(from, to)),
  ]);
  return containerInventoryOptions(products, routes);
}
