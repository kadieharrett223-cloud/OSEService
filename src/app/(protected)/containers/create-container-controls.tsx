"use client";

import { useFormStatus } from "react-dom";

export function CreateContainerControls({ onCancel }: { onCancel: () => void }) {
  const { pending } = useFormStatus();
  return (
    <div>
      <p role="status" aria-live="polite" className="mb-2 text-sm text-[#315b8d]">
        {pending ? "Saving container and products… Please wait; do not submit again." : ""}
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary" disabled={pending} onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={pending} aria-busy={pending}>
          {pending ? "Saving…" : "Save Container"}
        </button>
      </div>
    </div>
  );
}
