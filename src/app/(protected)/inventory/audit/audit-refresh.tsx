"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { auditRefreshOverdue, startAuditAutoRefresh } from "@/lib/inventory/audit-refresh";

export function AuditRefresh({ checkedAt }: { checkedAt: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [now, setNow] = useState(() => Date.parse(checkedAt));
  const busy = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { busy.current = pending; }, [pending]);
  useEffect(() => startAuditAutoRefresh(() => {
    if (!busy.current) startTransition(() => router.refresh());
  }, window, document, checkedAt), [router, startTransition, checkedAt]);
  return <div className="audit-controls mt-2 flex flex-wrap items-center gap-3 text-sm">
    <button type="button" disabled={pending} onClick={() => startTransition(() => router.refresh())} className="rounded border px-3 py-1 disabled:opacity-50">{pending ? "Refreshing…" : "Refresh now"}</button>
    <span role="status" aria-live="polite">{pending ? "Checking for new records…" : `Last checked ${new Date(checkedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "short", timeStyle: "medium" })} Pacific. Refreshes every 30 seconds while visible and when you return.`}</span>
    {auditRefreshOverdue(checkedAt, now) ? <p role="alert" className="w-full font-semibold text-amber-800">Refresh overdue. Figures below are from the last successful check. Use Refresh now to check again.</p> : null}
  </div>;
}
