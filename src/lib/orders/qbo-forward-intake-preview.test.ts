import { describe, expect, it } from "vitest";
import { buildQboForwardIntakePreview, selectObsoleteForwardIntakeReviews, type QboForwardIntakeSnapshot } from "./qbo-forward-intake-service";

function snapshot(): QboForwardIntakeSnapshot {
  return {
    invoices: [{ id: "invoice", qbo_invoice_id: "qbo-id", invoice_number: "127181", customer_id: "customer", payment_status: "Paid", invoice_date: "2026-09-23", created_at: "2026-09-24", raw_payload: { Line: [{ Id: "1", SalesItemLineDetail: { Qty: 1 } }, { Id: "2", SalesItemLineDetail: { Qty: 1 } }] } }],
    invoiceLines: [
      { id: "lift-line", qbo_invoice_id: "invoice", qbo_line_id: "1", qbo_sku: "4PC-6", source_description: "Lift", ordered_qty: 1, product_id: "lift" },
      { id: "missing-line", qbo_invoice_id: "invoice", qbo_line_id: "2", qbo_sku: "OD-3198A", source_description: "Oil drain", ordered_qty: 1, product_id: "drain" },
    ],
    orders: [{ id: "order", source_invoice_id: "invoice", duplicate_of_order_id: null, cancellation_status: "ACTIVE", review_status: "APPROVED", order_number: "127181", customer_id: "customer", legacy_customer_name: "Customer" }],
    orderLines: [{ shipping_order_id: "order", qbo_invoice_line_id: "lift-line", product_id: "lift", ordered_qty: 1, fulfilled_qty: 0, fulfillment_status: "PENDING" }],
    products: [{ id: "lift", sku: "4PC-6" }, { id: "drain", sku: "OD-3198A" }], aliases: [], resolutions: [],
  };
}
const preview = (s: QboForwardIntakeSnapshot) => buildQboForwardIntakePreview(s, new Map())[0]!;
const decision = (s: QboForwardIntakeSnapshot) => preview(s).lines[1]!.decision;

describe("exact-source forward intake", () => {
  it("adds a missing physical sibling to an approved open parent using invoice-date fallback", () => {
    const s = snapshot();
    const before = JSON.stringify(s);
    expect(decision(s)).toBe("AUTO_IMPORT");
    expect(preview(s).priorityDate).toBe("2026-09-23");
    expect(preview(s).firstPaymentAt).toBeNull();
    expect(JSON.stringify(s)).toBe(before);
  });
  it("is idempotent once the exact QBO line is represented", () => {
    const s = snapshot();
    s.orderLines.push({ ...s.orderLines[0]!, qbo_invoice_line_id: "missing-line", product_id: "drain" });
    expect(decision(s)).toBe("ALREADY_REPRESENTED");
    expect(selectObsoleteForwardIntakeReviews([preview(s)]).map(x => x.qboInvoiceLineId)).toContain("missing-line");
    s.orderLines[1]!.fulfilled_qty = 1;
    expect(decision(s)).toBe("CLOSED");
  });
  it("does not reactivate an unlinked shipped historical item", () => {
    const s = snapshot();
    s.orderLines.push({ ...s.orderLines[0]!, qbo_invoice_line_id: null, product_id: "drain", fulfilled_qty: 1, fulfillment_status: "FULFILLED" });
    expect(decision(s)).toBe("MANUAL_DUPLICATE_REVIEW");
  });
  it("does not silently reopen completed or unapproved parents", () => {
    const s = snapshot();
    s.orders[0]!.review_status = "PENDING_REVIEW";
    expect(decision(s)).toBe("MANUAL_DUPLICATE_REVIEW");
    s.orders[0]!.review_status = "APPROVED";
    s.orderLines[0]!.fulfilled_qty = 1;
    expect(decision(s)).toBe("MANUAL_DUPLICATE_REVIEW");
  });
  it("does not activate cancelled, voided or removed QBO lines", () => {
    const s = snapshot();
    s.orders[0]!.cancellation_status = "CANCELLED";
    expect(decision(s)).toBe("CLOSED");
    s.orders[0]!.cancellation_status = "ACTIVE";
    s.invoices[0]!.raw_payload!.PrivateNote = "VOIDED";
    expect(decision(s)).toBe("CLOSED");
    s.invoices[0]!.raw_payload = { Line: [{ Id: "1", SalesItemLineDetail: { Qty: 1 } }] };
    expect(decision(s)).toBe("CLOSED");
  });
  it("does not let an unfulfilled discount reopen a physically completed order", () => {
    const s = snapshot();
    s.orderLines[0]!.fulfilled_qty = 1;
    s.invoiceLines.push({ ...s.invoiceLines[0]!, id: "discount", qbo_sku: "Discount-1", product_id: null });
    s.orderLines.push({ ...s.orderLines[0]!, qbo_invoice_line_id: "discount", product_id: null, fulfilled_qty: 0, fulfillment_status: "PENDING" });
    expect(decision(s)).toBe("MANUAL_DUPLICATE_REVIEW");
  });
  it("keeps conflicting parents and stale source quantities in review", () => {
    const s = snapshot();
    s.orders.push({ ...s.orders[0]!, id: "other-parent" });
    expect(decision(s)).toBe("MANUAL_DUPLICATE_REVIEW");
    s.orders.pop();
    s.invoiceLines[1]!.ordered_qty = 2;
    expect(decision(s)).toBe("MANUAL_DUPLICATE_REVIEW");
  });
  it("honors reviewed lifecycle resolutions", () => {
    const s = snapshot();
    s.resolutions.push({ qbo_invoice_line_id: "missing-line", status: "ACTIVE" });
    expect(decision(s)).toBe("CLOSED");
  });
  it("does not confuse two unknown customers who share a printed invoice number", () => {
    const s = snapshot();
    s.invoices[0]!.customer_id = null;
    s.orders.push({ ...s.orders[0]!, id: "manual", source_invoice_id: null, customer_id: null, legacy_customer_name: null });
    s.orderLines.push({ ...s.orderLines[0]!, shipping_order_id: "manual", qbo_invoice_line_id: null, product_id: "drain" });
    expect(decision(s)).toBe("AUTO_IMPORT");
    s.orders[1]!.customer_id = "customer";
    s.invoices[0]!.customer_id = "customer";
    expect(decision(s)).toBe("MANUAL_DUPLICATE_REVIEW");
  });
  it("does not create physical demand from a mapped Install service", () => {
    const s = snapshot();
    s.invoiceLines[1]!.qbo_sku = "Install";
    expect(decision(s)).toBe("NO_INVENTORY_DEMAND");
  });
});
