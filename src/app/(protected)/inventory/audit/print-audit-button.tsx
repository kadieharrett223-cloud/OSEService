"use client";

export function PrintAuditButton() {
  return <button type="button" onClick={() => window.print()} className="rounded bg-slate-900 px-4 py-2 font-medium text-white print:hidden">Print / Save PDF</button>;
}
