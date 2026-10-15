"use client";

import { useFormStatus } from "react-dom";

export function AssignmentSubmitButton({ label, disabled = false, className = "btn-secondary" }: { label: string; disabled?: boolean; className?: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={className} disabled={disabled || pending} aria-busy={pending}>{pending ? "Saving…" : label}</button>;
}
