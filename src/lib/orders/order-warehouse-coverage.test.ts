import { expect, it } from "vitest";
import { resolveProductCoverage } from "@/lib/fulfillment/suggested-allocation";
import { orderWarehouseCoverage } from "./order-warehouse-coverage";

it("does not call a staged order in warehouse when its exact remaining units are reserved incoming", () => {
  const coverage = resolveProductCoverage("LIFT", {
    floorAvailableByProduct: new Map([["LIFT", 1]]),
    queueLinesByProduct: new Map([["LIFT", [{id:"line",product_id:"LIFT",remaining_qty:1,priority:"NORMAL",queue_position_start:1,approved_at:null,created_at:"2026-11-01",has_live_allocation:true,container_reserved_quantities:[{container_id:"incoming",quantity:1}]}]]]),
    containerSupplyByProduct: new Map([["LIFT", [{container_id:"incoming",container_number:"260",available_qty:1,entered_date:null,eta_confirmed_date:null,eta_estimated_date:null}]]]),
  }).lines;
  expect(orderWarehouseCoverage([{remaining:1,line:{id:"line",warehouse_status:"IN_WAREHOUSE"}}],coverage)).toEqual({inStockQty:0,stagedQty:0,incomingQty:1,fullyWarehouseCovered:false});
});

it("shares one physical coverage budget across repeated invoice rows", () => {
  const coverage = resolveProductCoverage("LIFT", {
    floorAvailableByProduct:new Map([["LIFT",1]]),
    queueLinesByProduct:new Map([["LIFT",[{id:"line",product_id:"LIFT",remaining_qty:2,priority:"NORMAL",queue_position_start:1,approved_at:null,created_at:"2026-11-01",has_live_allocation:false}]]]),
    containerSupplyByProduct:new Map(),
  }).lines;
  expect(orderWarehouseCoverage([1,1].map(remaining=>({remaining,line:{id:"line",warehouse_status:"IN_WAREHOUSE"}})),coverage)).toEqual({inStockQty:1,stagedQty:1,incomingQty:0,fullyWarehouseCovered:false});
});
