"use client";

import React from "react";
import { useFormStatus } from "react-dom";

export function OrderSubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary inline-flex items-center justify-center gap-2 disabled:cursor-wait disabled:opacity-75" disabled={pending} aria-busy={pending}>
      {pending ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white motion-reduce:animate-none" /> : null}
      <span role="status" aria-live="polite">{pending ? pendingLabel : label}</span>
    </button>
  );
}
