"use client";

import { useFormStatus } from "react-dom";

export function RefreshQuickbooksButton({ compact = false }: { compact?: boolean }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      className={`${compact ? "btn-secondary text-xs" : "btn-primary"} inline-flex items-center justify-center gap-2 disabled:cursor-wait disabled:opacity-70`}
      disabled={pending}
      aria-disabled={pending}
      aria-busy={pending}
      title={pending ? "Loading the latest QuickBooks invoice data" : "Fetch the latest invoice and line-item changes directly from QuickBooks"}
    >
      {pending ? (
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      <span aria-live="polite">{pending ? "Refreshing from QuickBooks…" : compact ? "Refresh QuickBooks" : "Refresh from QuickBooks"}</span>
    </button>
  );
}
