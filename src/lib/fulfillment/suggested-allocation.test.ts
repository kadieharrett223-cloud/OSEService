import { describe, expect, it } from "vitest";
import { resolveProductCoverage, validateProductCoverage, type OpenQueueLine, type ProductContainerSupply } from "./suggested-allocation";
import { canonicalSkuKey } from "@/lib/products/canonical-sku";

const productId = "product-1";
const created_at = "2026-08-01T00:00:00.000Z";

function line(id: string, remaining_qty: number, queue_position_start: number, overrides: Partial<OpenQueueLine> = {}): OpenQueueLine {
  return {
    id,
    product_id: productId,
    remaining_qty,
    priority: "NORMAL",
    queue_position_start,
    approved_at: created_at,
    created_at,
    has_live_allocation: false,
    ...overrides,
  };
}

function container(container_id: string, container_number: string, available_qty: number, eta_confirmed_date: string | null, overrides: Partial<ProductContainerSupply> = {}): ProductContainerSupply {
  return { container_id, container_number, available_qty, eta_confirmed_date, eta_estimated_date: null, entered_date: null, ...overrides };
}

describe("shared product coverage resolver", () => {
  it("allocates warehouse first, then incoming supply by ETA, at unit/range level", () => {
    const result = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 2]]),
      queueLinesByProduct: new Map([[productId, [line("A", 1, 1), line("B", 2, 2), line("C", 1, 4), line("D", 2, 5)]]]),
      containerSupplyByProduct: new Map([[productId, [container("c1", "Container 1", 2, "2026-08-25"), container("c2", "Container 2", 5, "2026-09-10")]]]),
    });

    expect(result.allocations.map((allocation) => `${allocation.orderLineId}:${allocation.quantity}:${allocation.sourceLabel}:${allocation.etaDate ?? "now"}`)).toEqual([
      "A:1:Warehouse:now",
      "B:1:Warehouse:now",
      "B:1:Container 1:2026-08-25",
      "C:1:Container 1:2026-08-25",
      "D:2:Container 2:2026-09-10",
    ]);
    expect(result.lines.get("D")?.completeEtaDate).toBe("2026-09-10");
  });

  it("uses canonical queue position ahead of the legacy priority label", () => {
    const result = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 1]]),
      queueLinesByProduct: new Map([[productId, [
        line("paid-first", 1, 1, { priority: "LOW" }),
        line("paid-later", 1, 2, { priority: "CRITICAL" }),
      ]]]),
      containerSupplyByProduct: new Map(),
    });

    expect(result.lines.get("paid-first")?.warehouseQty).toBe(1);
    expect(result.lines.get("paid-later")?.unassignedQty).toBe(1);
  });

  it("exhausts an earlier reliable-ETA container before committing a later container", () => {
    const result = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 0]]),
      queueLinesByProduct: new Map([[productId, [line("A", 10, 1), line("B", 10, 11)]]]),
      containerSupplyByProduct: new Map([[productId, [
        container("c254", "254", 12, "2026-11-30"),
        container("c240", "240", 24, "2026-10-15"),
      ]]]),
    });

    expect(result.allocations.map((allocation) => `${allocation.orderLineId}:${allocation.quantity}:${allocation.sourceLabel}`)).toEqual([
      "A:10:240",
      "B:10:240",
    ]);
  });

  it("uses older container chronology before a newer dated container when ETA is missing", () => {
    const result = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 0]]),
      queueLinesByProduct: new Map([[productId, [line("A", 24, 1), line("B", 12, 25)]]]),
      containerSupplyByProduct: new Map([[productId, [
        container("c254", "254", 12, "2026-11-30"),
        container("c240", "240", 24, null, { entered_date: "2026-08-01" }),
      ]]]),
    });

    expect(result.allocations.map((allocation) => `${allocation.orderLineId}:${allocation.quantity}:${allocation.sourceLabel}`)).toEqual([
      "A:24:240",
      "B:12:254",
    ]);
  });

  it("cascades coverage when earlier demand is cancelled without changing supply", () => {
    const result = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 2]]),
      queueLinesByProduct: new Map([[productId, [line("B", 2, 1), line("C", 1, 3), line("D", 2, 4)]]]),
      containerSupplyByProduct: new Map([[productId, [container("c1", "Container 1", 2, "2026-08-25"), container("c2", "Container 2", 5, "2026-09-10")]]]),
    });

    expect(result.allocations.map((allocation) => `${allocation.orderLineId}:${allocation.quantity}:${allocation.sourceLabel}:${allocation.etaDate ?? "now"}`)).toEqual([
      "B:2:Warehouse:now",
      "C:1:Container 1:2026-08-25",
      "D:1:Container 1:2026-08-25",
      "D:1:Container 2:2026-09-10",
    ]);
  });

  it("excludes Dropship and Other demand from warehouse/container coverage", () => {
    const result = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 2]]),
      queueLinesByProduct: new Map([[productId, [line("B", 2, 1), line("C", 1, 3), line("D", 2, 4, { fulfillment_source: "DROPSHIP" })]]]),
      containerSupplyByProduct: new Map([[productId, [container("c1", "Container 1", 2, "2026-08-25"), container("c2", "Container 2", 5, "2026-09-10")]]]),
    });

    expect(result.lines.has("D")).toBe(false);
    expect(result.allocations.map((allocation) => `${allocation.orderLineId}:${allocation.quantity}:${allocation.sourceLabel}:${allocation.etaDate ?? "now"}`)).toEqual([
      "B:2:Warehouse:now",
      "C:1:Container 1:2026-08-25",
    ]);
  });

  it("pins explicit warehouse reservations while consuming ON_FLOOR only once", () => {
    const result = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 2]]),
      queueLinesByProduct: new Map([[productId, [
        line("A", 1, 1),
        line("B", 1, 2),
        line("ReservedLater", 1, 99, { warehouse_reserved_qty: 1 }),
      ]]]),
      containerSupplyByProduct: new Map([[productId, [container("c1", "Container 1", 5, "2026-08-25")]]]),
    });

    expect(result.lines.get("ReservedLater")?.warehouseQty).toBe(1);
    expect(result.lines.get("A")?.warehouseQty).toBe(1);
    expect(result.lines.get("B")?.incomingQty).toBe(1);
    expect(result.allocations.filter((allocation) => allocation.sourceType === "WAREHOUSE").reduce((sum, allocation) => sum + allocation.quantity, 0)).toBe(2);
  });

  it("moves incoming coverage to warehouse after container receipt increases ON_FLOOR", () => {
    const result = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 4]]),
      queueLinesByProduct: new Map([[productId, [line("B", 2, 1), line("C", 1, 3)]]]),
      containerSupplyByProduct: new Map([[productId, [container("c2", "Container 2", 5, "2026-09-10")]]]),
    });

    expect(result.lines.get("C")?.allocations).toMatchObject([{ sourceType: "WAREHOUSE", quantity: 1 }]);
  });

  it("keeps recycled 4PC-6 demand visible on Container 245 after warehouse coverage", () => {
    const demandProductKey = canonicalSkuKey("HK-4PC-6");
    const supplyProductKey = canonicalSkuKey("4PC-6");
    expect(demandProductKey).toBe(supplyProductKey);

    const queue = [
      ...Array.from({ length: 9 }, (_, index) => line(`warehouse-${index + 1}`, 1, index + 1, { product_id: demandProductKey })),
      line("stratos", 6, 10, { product_id: demandProductKey }),
      ...["steven", "wholesale", "henry", "raymond", "gerardo", "spring-creek", "dave"].map((id, index) => line(id, 1, 16 + index, { product_id: demandProductKey })),
    ];
    const result = resolveProductCoverage(supplyProductKey, {
      floorAvailableByProduct: new Map([[supplyProductKey, 11]]),
      queueLinesByProduct: new Map([[supplyProductKey, queue]]),
      containerSupplyByProduct: new Map([[supplyProductKey, [container("245", "245", 40, "2026-09-01")]]]),
    });
    const container245 = result.allocations.filter((allocation) => allocation.sourceType === "CONTAINER" && allocation.sourceId === "245");

    expect(container245.reduce((sum, allocation) => sum + allocation.quantity, 0)).toBe(11);
    expect(container245.map((allocation) => `${allocation.orderLineId}:${allocation.quantity}`)).toEqual([
      "stratos:4",
      "steven:1",
      "wholesale:1",
      "henry:1",
      "raymond:1",
      "gerardo:1",
      "spring-creek:1",
      "dave:1",
    ]);
  });

  it("validates coverage against the same resolver output", () => {
    const result = resolveProductCoverage(productId, {
      floorAvailableByProduct: new Map([[productId, 1]]),
      queueLinesByProduct: new Map([[productId, [line("A", 1, 1), line("B", 1, 2)]]]),
      containerSupplyByProduct: new Map([[productId, [container("c1", "Container 1", 1, "2026-08-25")]]]),
    });

    expect(validateProductCoverage(result)).toEqual([]);
  });
});
