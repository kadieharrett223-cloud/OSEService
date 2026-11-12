import { normalizeFulfillmentSource } from "./fulfillment-source";

/** Queue membership and catalog mapping are separate facts; review flags do not unmap a product. */
export function customerQueueLabel(line: { product_id?: string | null; fulfillment_source?: string | null }, position?: string | null) {
  const source = normalizeFulfillmentSource(line.fulfillment_source);
  if (source === "CUSTOMER_NOT_READY") return "Customer list: Excluded — Customer Not Ready";
  if (source === "OTHER") return "Customer list: Excluded — Other fulfillment";
  if (position) return `Customer list position: #${position}`;
  if (!line.product_id) return "Customer list: Inventory item not linked";
  return "Customer list: Not in the active list — check order eligibility";
}
