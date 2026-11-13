import { describe, expect, it } from "vitest";
import { hasMappingSourceProblem, inventoryCoverageSource, isMappingSourceBypass } from "./other-source-safety";
import { otherFulfillmentQueueIdentities } from "@/lib/demand/customer-queue-source";
import { getCanonicalOpenDemandLines, openQtyOf } from "@/lib/demand/product-demand";
import { customerQueueLabel } from "./customer-queue-label";
import { evaluateOrderHealth } from "./order-health";

describe("mapping problems cannot hide warehouse obligations", () => {
  it.each(["OCC Mapping Error", "OCC Mapping issue", "Mapping fix", "Wrong product mapping", "Unmapped product"])("rejects the workaround %s", (note) => {
    expect(hasMappingSourceProblem(note)).toBe(true);
  });
  it("restores only the open mapped obligation to shared inventory demand, without changing source, quantities or priority", () => {
    const line = { id: "ap-line", qbo_invoice_line_id: "qbo-ap", product_id: "platform", fulfillment_source: "OTHER", fulfillment_notes: "OCC Mapping Error", ordered_qty: 1, approved_qty: 1, fulfilled_qty: 0, approval_status: "APPROVED", fulfillment_status: "PENDING", queue_position_start: 3 };
    const before = structuredClone(line);
    const canonical = getCanonicalOpenDemandLines([line], new Set(), new Set());
    expect(canonical).toHaveLength(1);
    expect(otherFulfillmentQueueIdentities(canonical).size).toBe(0);
    expect(openQtyOf(canonical[0])).toBe(1);
    expect(inventoryCoverageSource(canonical[0])).toBe("WAREHOUSE");
    expect(customerQueueLabel(line,"3")).toBe("Customer list position: #3");
    expect(line).toEqual(before);
  });
  it("does not reopen completed or cancelled historical quantities", () => {
    const base = { id: "historical", product_id: "lift", fulfillment_source: "OTHER", fulfillment_notes: "OCC Mapping Error", ordered_qty: 1, approved_qty: 1, approval_status: "APPROVED" };
    expect(getCanonicalOpenDemandLines([{ ...base, fulfilled_qty: 1, fulfillment_status: "FULFILLED" }],new Set(),new Set())).toHaveLength(0);
    expect(getCanonicalOpenDemandLines([{ ...base, fulfilled_qty: 0, fulfillment_status: "CANCELLED" }],new Set(),new Set())).toHaveLength(0);
  });
  it("preserves legitimate non-warehouse sources and explicit customer readiness", () => {
    for (const fulfillment_source of ["OTHER","DROPSHIP","CUSTOMER_NOT_READY"]) {
      const line = { fulfillment_source, fulfillment_notes: "Customer supplied equipment, reference123" };
      expect(isMappingSourceBypass(line)).toBe(false);
      expect(inventoryCoverageSource(line)).toBe(fulfillment_source);
    }
  });
  it("surfaces the saved legacy exception instead of reporting a clean order", () => {
    const issues=evaluateOrderHealth({lines:[{id:"legacy",product_id:"lift",ordered_qty:1,approved_qty:1,fulfilled_qty:1,fulfillment_status:"FULFILLED",fulfillment_source:"OTHER",fulfillment_notes:"OCC Mapping Error"}]});
    expect(issues.some(x=>x.code==="OTHER_MAPPING_BYPASS")).toBe(true);
  });
});
