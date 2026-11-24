import { expect, it } from "vitest";
import { lineSourceReservations } from "./line-source-reservations";
import { resolveProductCoverage } from "./suggested-allocation";
import { classifyQboForwardIntakeLine } from "../orders/qbo-forward-intake";

it("keeps a container-assigned order incoming despite a stale warehouse flag and available floor stock", () => {
  const reservation = lineSourceReservations(2, "IN_WAREHOUSE", [
    { source_type: "CONTAINER", container_id: "261", quantity: 2, allocation_status: "ALLOCATED" },
  ]);
  expect(reservation.warehouse_reserved_qty).toBe(0);
  const result = resolveProductCoverage("lift", {
    floorAvailableByProduct: new Map([["lift", 5]]),
    queueLinesByProduct: new Map([["lift", [{ id: "reserved", product_id: "lift", remaining_qty: 2, priority: "NORMAL", queue_position_start: 1, approved_at: null, created_at: "2026-11-01", has_live_allocation: true, ...reservation }]]]),
    containerSupplyByProduct: new Map([["lift", [{ container_id: "261", container_number: "261", available_qty: 6, eta_confirmed_date: "2027-01-15", eta_estimated_date: null, entered_date: null }]]]),
  });
  expect(result.lines.get("reserved")).toMatchObject({ warehouseQty: 0, incomingQty: 2, completeEtaDate: "2027-01-15" });
});

it("reconciles every newly imported obligation behind existing demand, rather than reusing the SKU stock total", () => {
  expect(classifyQboForwardIntakeLine({ isPaymentEligible: true, isInventoryDemandLine: true, hasExactExistingLine: false, hasTerminalOrReviewedResolution: false, hasMappedProduct: true, hasPossibleManualDuplicate: false, hasConflictingSkuIdentity: false })).toBe("AUTO_IMPORT");
  const lines = ["earlier", "new-import"].map((id, index) => ({ id, product_id: "lift", remaining_qty: 1, priority: "NORMAL", queue_position_start: index + 1, approved_at: null, created_at: "2026-11-01", has_live_allocation: false, fulfillment_source: "WAREHOUSE", ...lineSourceReservations(1, "APPROVED") }));
  const input = { floorAvailableByProduct: new Map([["lift", 1]]), queueLinesByProduct: new Map([["lift", lines]]), containerSupplyByProduct: new Map([["lift", [{ container_id: "266", container_number: "266", available_qty: 1, eta_confirmed_date: null, eta_estimated_date: "2027-01-31", entered_date: null }]]]) };
  for (let refresh = 0; refresh < 2; refresh++) {
    const result = resolveProductCoverage("lift", input);
    expect(result.lines.get("earlier")).toMatchObject({ warehouseQty: 1, incomingQty: 0 });
    expect(result.lines.get("new-import")).toMatchObject({ warehouseQty: 0, incomingQty: 1, completeEtaDate: "2027-01-31" });
  }
  expect(lines.map(line => line.queue_position_start)).toEqual([1, 2]);
  expect(input.floorAvailableByProduct.get("lift")).toBe(1);
});

it("keeps partial reservations distinct and ignores released assignments", () => {
  expect(lineSourceReservations(3, "READY_TO_SHIP", [
    { source_type: "CONTAINER", container_id: "261", quantity: 2, allocation_status: "ALLOCATED" },
    { source_type: "CONTAINER", container_id: "old", quantity: 99, allocation_status: "RELEASED" },
  ])).toEqual({ warehouse_reserved_qty: 1, container_reserved_quantities: [{ container_id: "261", quantity: 2 }] });
});

it("does not manufacture warehouse readiness from assignments exceeding physical stock", () => {
  const result = resolveProductCoverage("lift", {
    floorAvailableByProduct: new Map([["lift", 1]]),
    queueLinesByProduct: new Map([["lift", [1, 2].map(position => ({ id: String(position), product_id: "lift", remaining_qty: 1, priority: "NORMAL", queue_position_start: position, approved_at: null, created_at: "2026-11-01", has_live_allocation: true, ...lineSourceReservations(1, "IN_WAREHOUSE") }))]]),
    containerSupplyByProduct: new Map(),
  });
  expect(result.lines.get("1")?.warehouseQty).toBe(1);
  expect(result.lines.get("2")).toMatchObject({ warehouseQty: 0, unassignedQty: 1 });
});
