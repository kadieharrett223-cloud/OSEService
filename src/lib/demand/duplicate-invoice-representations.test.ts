import { expect, it } from "vitest";
import { withoutDuplicateInvoiceRepresentations } from "./duplicate-invoice-representations";

const keys = new Map([["panel", "PANEL"]]);
const line = (id: string, qty: number, direct: boolean) => ({ id, product_id: "panel", approved_qty: qty, ordered_qty: qty, fulfilled_qty: 0,
  qbo_invoice_line_id: direct ? id : null, source_record_id: direct ? null : id, shipping_orders: { source_invoice_id: "unique-invoice" } });
it("counts matching split invoice and historical source families once without changing their records", () => {
  const rows = [line("qbo-two", 2, true), line("qbo-one", 1, true), line("old-one", 1, false), line("old-two", 2, false)];
  const before = JSON.stringify(rows);
  expect(withoutDuplicateInvoiceRepresentations(rows, keys).map(r => r.id)).toEqual(["qbo-two", "qbo-one"]);
  expect(JSON.stringify(rows)).toBe(before);
});
it("retains unmatched quantities, different unique invoices, live allocations and manual priority", () => {
  const qbo = line("qbo", 1, true), old = line("old", 1, false);
  for (const legacy of [{ ...old, approved_qty: 2, ordered_qty: 2 }, { ...old, shipping_orders: { source_invoice_id: "other-invoice" } },
    { ...old, inventory_allocations: [{ allocation_status: "ALLOCATED" }] }, { ...old, queue_position_override: 1 }, { ...old, fulfilled_qty: 1 }]) {
    expect(withoutDuplicateInvoiceRepresentations([qbo, legacy], keys)).toHaveLength(2);
  }
});
