import { describe, expect, it } from "vitest";
import { auditCurrentFloor, auditFulfillmentMovements, auditProductScope, auditRowsInPeriod, type AuditMovement } from "./audit-history";

const products = [{ id: "old", sku: "000002", canonical_name: "2PCF-9" }, { id: "owner", sku: "2PCF-9", canonical_name: "2PCF-9" }, { id: "other", sku: "OTHER", canonical_name: "Different item" }];
const routes = [{ product_id: "old", stock_product_id: "owner", operational_key: "2PCF9" }, { product_id: "owner", stock_product_id: "owner", operational_key: "2PCF9" }, { product_id: "other", stock_product_id: "other", operational_key: "OTHER" }];
const movement = (id: string, product_id: string, delta: number, source_event_key: string | null = null) => ({ id, product_id, delta, bucket: "ON_FLOOR", source_event_key, created_at: "2026-11-10T18:00:00Z" }) as AuditMovement;

describe("inventory audit evidence", () => {
  it("includes routed stock owners while excluding unrelated recycled aliases", () => {
    expect(auditProductScope(products, [{ product_id: "other", alias: "2PCF-9" }], routes, "2PCF-9").map(p => p.id)).toEqual(["old", "owner"]);
    expect(auditProductScope(products, [], routes, "000002").map(p => p.id)).toEqual(["old", "owner"]);
    expect(auditCurrentFloor(["old", "owner"], routes, [movement("stale", "old", 40), movement("baseline", "owner", 5), movement("ship4", "owner", -4), movement("ship1", "owner", -1)])).toBe(0);
  });
  it("fails instead of showing a guessed balance when stock routing is missing", () => {
    expect(() => auditCurrentFloor(["owner"], [], [])).toThrow("cannot be verified");
  });
  it("links deductions and reversals by exact event keys, including shipment edits", () => {
    const rows = [movement("ship", "owner", -4, "ORDER_SHIPMENT:s:line:ON_FLOOR"), movement("other", "owner", -4, "ORDER_SHIPMENT:s:other:ON_FLOOR"), movement("edit", "owner", 1, "ORDER_SHIPMENT_EDIT:s:line:unique:ON_FLOOR")];
    expect(auditFulfillmentMovements("ORDER_SHIPMENT:s:line", rows).map(r => r.id)).toEqual(["ship"]);
    expect(auditFulfillmentMovements("ORDER_SHIPMENT_EDIT:s:line:unique", rows).map(r => r.delta)).toEqual([1]);
    expect(auditFulfillmentMovements(null, rows)).toEqual([]);
  });
  it("filters history by recording date without changing the all-history current stock", () => {
    const rows = [{ ...movement("count", "owner", 5), created_at: "2026-10-14T20:00:00Z" }, movement("new-shipment", "owner", -5)];
    expect(auditRowsInPeriod(rows, "2026-11-09T08:00:00Z", "2026-11-10T19:00:00Z").map(r => r.id)).toEqual(["new-shipment"]);
    expect(auditCurrentFloor(["owner"], routes, rows)).toBe(0);
  });
});
