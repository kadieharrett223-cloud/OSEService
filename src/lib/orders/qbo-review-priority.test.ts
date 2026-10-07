import { describe, expect, it } from "vitest";
import { compareQboReviewPriority, formatQboReviewPriority, qboReviewPriority, type QboReviewPriorityRow } from "./qbo-review-priority";

const row = (id: string, invoice: string, date: string | null, paid: string | null = null): QboReviewPriorityRow => ({
  id, invoice_number: invoice, first_payment_at: paid, qbo_invoice_lines: { qbo_invoices: { invoice_date: date } },
});

describe("QBO review priority", () => {
  it("uses invoice creation without fabricating a payment", () => {
    const review = row("a", "127181", "2026-09-23");
    expect(qboReviewPriority(review)).toEqual({ date: "2026-09-23", source: "Invoice date (fallback)" });
    expect(review.first_payment_at).toBeNull();
    expect(formatQboReviewPriority(review)).toBe("9/23/2026");
  });
  it("prefers real payment evidence over the fallback", () => {
    expect(qboReviewPriority(row("a", "1", "2026-09-23", "2026-09-25T00:00:00Z")).date).toBe("2026-09-25T00:00:00Z");
  });
  it("sorts mixed payment/fallback dates oldest first with stable numeric invoice ties", () => {
    const rows = [row("d", "5", null), row("c", "100", "2026-09-23"), row("b", "99", "2026-09-23"), row("a", "7", "2026-09-25", "2026-09-20")];
    expect(rows.sort(compareQboReviewPriority).map(x => x.id)).toEqual(["a", "b", "c", "d"]);
  });
});
