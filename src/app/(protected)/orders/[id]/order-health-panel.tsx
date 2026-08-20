"use client";

import { useState } from "react";
import type { OrderHealthIssue } from "@/lib/orders/order-health";

export function OrderHealthPanel({ issues }: { issues: OrderHealthIssue[] }) {
  const [open, setOpen] = useState(false);
  const hasErrors = issues.some((issue) => issue.severity === "ERROR");
  const label = issues.length === 0 ? "Order Health: Clean" : `Order Health: ${issues.length} Issue${issues.length === 1 ? "" : "s"}`;
  return (
    <div>
      <button type="button" onClick={() => setOpen((value) => !value)} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${issues.length === 0 ? "bg-[#e7f7ed] text-[#1b7a43]" : hasErrors ? "bg-[#fee2e2] text-[#b91c1c]" : "bg-[#fff7e6] text-[#92400e]"}`} aria-expanded={open}>
        {issues.length === 0 ? "✓" : "⚠"} {label}
      </button>
      {open && issues.length > 0 ? (
        <div className="mt-2 w-full max-w-xl rounded-lg border border-[#e5e7eb] bg-white p-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">Read-only discrepancy details</p>
          <div className="mt-2 space-y-2">
            {issues.map((issue, index) => (
              <div key={`${issue.code}-${index}`} className="rounded-md border border-[#eef2f7] bg-[#fafbfc] p-2 text-xs">
                <p className={`font-semibold ${issue.severity === "ERROR" ? "text-[#b91c1c]" : issue.severity === "WARNING" ? "text-[#92400e]" : "text-[#475569]"}`}>{issue.severity} · {issue.issue}</p>
                {issue.product ? <p className="mt-1 font-medium text-[#334155]">{issue.product}</p> : null}
                <p className="mt-1 text-[#64748b]">Expected: {issue.expected} · Actual: {issue.actual}</p>
                <p className="mt-1 text-[#64748b]">{issue.cause}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
