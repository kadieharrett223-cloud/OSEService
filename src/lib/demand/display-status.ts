export type WarehouseDemandInput = {
  openQty: number;
  warehouseStatus: string | null | undefined;
  warehouseQty?: number | null;
  willCall?: boolean;
};

export type WarehouseDemandDisplay = {
  warehouseQty: number;
  waitingQty: number;
  inWarehouse: boolean;
  willCall: boolean;
};

const WAREHOUSE_STATES = new Set(["IN_WAREHOUSE", "PICKED", "READY_TO_SHIP"]);

/** Uses only persisted warehouse state; floor availability cannot create this status. */
export function getWarehouseDemandDisplay(input: WarehouseDemandInput): WarehouseDemandDisplay {
  const openQty = Math.max(0, input.openQty);
  const explicitQty = input.warehouseQty == null ? null : Math.max(0, Number(input.warehouseQty));
  const warehouseQty = Math.min(openQty, explicitQty ?? (WAREHOUSE_STATES.has(String(input.warehouseStatus ?? "").toUpperCase()) ? openQty : 0));
  return {
    warehouseQty,
    waitingQty: Math.max(0, openQty - warehouseQty),
    inWarehouse: warehouseQty > 0,
    willCall: Boolean(input.willCall),
  };
}
