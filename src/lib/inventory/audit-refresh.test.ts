import { afterEach, expect, it, vi } from "vitest";
import { AUDIT_REFRESH_MS, auditRefreshOverdue, startAuditAutoRefresh } from "./audit-refresh";

afterEach(() => vi.useRealTimers());
it("updates visible reports, refreshes returning tabs, pauses during filter edits, and cleans up", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible", activeElement: null as { tagName: string } | null });
  const refresh = vi.fn();
  const stop = startAuditAutoRefresh(refresh, win as Window, doc as unknown as Document);
  vi.advanceTimersByTime(AUDIT_REFRESH_MS); expect(refresh).toHaveBeenCalledTimes(1);
  doc.visibilityState = "hidden"; vi.advanceTimersByTime(AUDIT_REFRESH_MS); expect(refresh).toHaveBeenCalledTimes(1);
  doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); expect(refresh).toHaveBeenCalledTimes(2);
  win.dispatchEvent(new Event("focus")); expect(refresh).toHaveBeenCalledTimes(2);
  doc.activeElement = { tagName: "INPUT" }; vi.advanceTimersByTime(AUDIT_REFRESH_MS); expect(refresh).toHaveBeenCalledTimes(2);
  doc.activeElement = null; vi.advanceTimersByTime(AUDIT_REFRESH_MS); expect(refresh).toHaveBeenCalledTimes(3);
  stop(); vi.advanceTimersByTime(AUDIT_REFRESH_MS); win.dispatchEvent(new Event("focus")); expect(refresh).toHaveBeenCalledTimes(3);
});

it("immediately replaces an old report restored by browser Back", () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-10T18:00:00Z"));
  const refresh = vi.fn();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible", activeElement: null });
  const stop = startAuditAutoRefresh(refresh, new EventTarget() as Window, doc as unknown as Document, "2026-11-10T17:59:00Z");
  expect(refresh).toHaveBeenCalledOnce();
  stop();
});

it("marks an unrefreshed snapshot overdue instead of implying old figures are current", () => {
  const at = "2026-11-10T18:00:00Z";
  expect(auditRefreshOverdue(at, Date.parse(at) + 30_000)).toBe(false);
  expect(auditRefreshOverdue(at, Date.parse(at) + 91_000)).toBe(true);
  expect(auditRefreshOverdue("unavailable", Date.parse(at))).toBe(true);
});
