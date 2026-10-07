import { qboIntakePriorityDate } from "./qbo-intake-policy";

export type QboReviewPriorityRow = {
  id: string;
  invoice_number: string | null;
  first_payment_at: string | null;
  qbo_invoice_lines?: { qbo_invoices?: { invoice_date: string | null } | null } | null;
};

/** Preserve payment facts; invoice creation is a sorting fallback, not a fabricated payment. */
export function qboReviewPriority(row: QboReviewPriorityRow) {
  const date = qboIntakePriorityDate(row.first_payment_at, row.qbo_invoice_lines?.qbo_invoices?.invoice_date);
  return { date, source: row.first_payment_at ? "First paid" : date ? "Invoice date (fallback)" : "Date unavailable" };
}

export function compareQboReviewPriority(left: QboReviewPriorityRow, right: QboReviewPriorityRow) {
  const timestamp = (row: QboReviewPriorityRow) => {
    const parsed = Date.parse(qboReviewPriority(row).date ?? "");
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };
  return timestamp(left) - timestamp(right)
    || String(left.invoice_number ?? "").localeCompare(String(right.invoice_number ?? ""), undefined, { numeric: true })
    || left.id.localeCompare(right.id);
}

export function formatQboReviewPriority(row: QboReviewPriorityRow) {
  const { date } = qboReviewPriority(row);
  if (!date) return "Date unavailable";
  // A QBO invoice date is a calendar date. UTC formatting avoids displaying
  // the preceding day when the server/user is west of UTC.
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC" })
    : new Date(date).toLocaleString("en-US");
}
