export const AUDIT_REFRESH_MS = 30_000;

export function auditRefreshOverdue(checkedAt: string, now: number) {
  return !Number.isFinite(Date.parse(checkedAt)) || now - Date.parse(checkedAt) > 3 * AUDIT_REFRESH_MS;
}

/** Refresh visible reports and returning tabs; leave filters alone while someone is editing them. */
export function startAuditAutoRefresh(
  refresh: () => void,
  win: Pick<Window, "addEventListener" | "removeEventListener">,
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState" | "activeElement">,
  checkedAt?: string,
) {
  let lastRefresh = 0;
  const check = () => {
    if (doc.visibilityState !== "visible" || /^(INPUT|TEXTAREA|SELECT)$/.test(doc.activeElement?.tagName ?? "")) return;
    if (Date.now() - lastRefresh < 1_000) return;
    lastRefresh = Date.now();
    refresh();
  };
  const timer = setInterval(check, AUDIT_REFRESH_MS);
  win.addEventListener("focus", check);
  doc.addEventListener("visibilitychange", check);
  // A browser Back navigation can restore an old server payload without a network request.
  if (checkedAt && Date.now() - Date.parse(checkedAt) >= AUDIT_REFRESH_MS) check();
  return () => {
    clearInterval(timer);
    win.removeEventListener("focus", check);
    doc.removeEventListener("visibilitychange", check);
  };
}
