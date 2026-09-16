"use client";

import { useFormStatus } from "react-dom";

export function SyncInvoicesButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  const isDisabled = Boolean(disabled || pending);

  return (
    <button
      type="submit"
      className="btn-secondary min-w-40"
      disabled={isDisabled}
      aria-live="polite"
      aria-busy={pending}
    >
      {pending ? "Syncing QuickBooks…" : "Sync Invoices"}
    </button>
  );
}
