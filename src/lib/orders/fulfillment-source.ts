export type FulfillmentSource = "WAREHOUSE" | "DROPSHIP" | "OTHER";

export function normalizeFulfillmentSource(value: string | null | undefined): FulfillmentSource | null {
  const source = String(value ?? "").trim().toUpperCase();
  if (source === "FLOOR" || source === "WAREHOUSE") return "WAREHOUSE";
  if (source === "DROPSHIP") return "DROPSHIP";
  if (source === "OTHER") return "OTHER";
  return null;
}

export function shouldMoveWarehouseInventory(source: string | null | undefined) {
  return normalizeFulfillmentSource(source) === "WAREHOUSE";
}

export function shouldCreateWarehouseReservation(source: string | null | undefined) {
  return normalizeFulfillmentSource(source) === "WAREHOUSE";
}

export function formatSavedFulfillmentSource(
  source: string | null | undefined,
  supplier: string | null | undefined,
) {
  const normalized = normalizeFulfillmentSource(source);
  if (normalized === "DROPSHIP") return supplier ? `Dropship · ${supplier}` : "Dropship";
  if (normalized === "OTHER") return "Other fulfillment";
  return null;
}
