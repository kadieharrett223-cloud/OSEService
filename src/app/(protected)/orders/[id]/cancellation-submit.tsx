"use client";

import { useFormStatus } from "react-dom";

export function CancellationSubmit({ onDismiss }: { onDismiss?: () => void }) {
  const { pending } = useFormStatus();
  return <div className="mt-3" aria-busy={pending}>
    <div className="flex flex-wrap items-center gap-2">
      {onDismiss ? <button type="button" className="btn-secondary disabled:cursor-wait disabled:opacity-60" disabled={pending} onClick={onDismiss}>Keep open</button> : null}
      <button type="submit" disabled={pending} aria-busy={pending} className="inline-flex items-center justify-center gap-2 rounded-md border border-[#dc2626] px-3 py-1.5 font-semibold text-[#b91c1c] hover:bg-[#fee2e2] disabled:cursor-wait disabled:opacity-75">
        {pending ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" /> : null}
        {pending ? "Cancelling order…" : "Confirm cancellation"}
      </button>
    </div>
    <p role="status" aria-live="polite" className={pending ? "mt-2 text-sm text-[#7f1d1d]" : "sr-only"}>
      {pending ? "Cancelling the order and updating customer lists. This may take a few minutes. Please keep this page open and wait for confirmation." : ""}
    </p>
  </div>;
}
