/**
 * Shared business boundary for automatic QuickBooks order intake.
 *
 * June 1, 2026 covers the rolling three-month reconciliation window selected
 * when OCC intake was hardened. Older records remain available to the
 * historical-review workflow, but are never silently activated as demand.
 */
export const QBO_AUTOMATIC_INTAKE_START_ISO = "2026-06-01T00:00:00.000Z";

const QBO_AUTOMATIC_INTAKE_START = Date.parse(QBO_AUTOMATIC_INTAKE_START_ISO);

export function qboIntakePriorityDate(
  firstPaymentAt: string | null | undefined,
  invoiceDate?: string | null,
) {
  return firstPaymentAt || invoiceDate || null;
}

/** Paid status proves eligibility; invoice date is the required fallback when payment dating is unavailable. */
export function isWithinAutomaticQboIntake(
  firstPaymentAt: string | null | undefined,
  invoiceDate?: string | null,
) {
  const priorityDate = qboIntakePriorityDate(firstPaymentAt, invoiceDate);
  if (!priorityDate) return false;
  const paidAt = Date.parse(priorityDate);
  return Number.isFinite(paidAt) && paidAt >= QBO_AUTOMATIC_INTAKE_START;
}
