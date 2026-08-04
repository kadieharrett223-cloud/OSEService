"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { autosaveCustomerInfoWorkspaceAction } from "@/app/(protected)/cases/[id]/actions";

type AutoSaveState = {
  ok: boolean;
  savedAt?: string;
  error?: string;
};

type CustomerInfoAutosaveFormProps = {
  caseId: string;
  shippingAddress: string;
};

const initialState: AutoSaveState = { ok: true };

export function CustomerInfoAutosaveForm({
  caseId,
  shippingAddress,
}: CustomerInfoAutosaveFormProps) {
  const [state, formAction, isPending] = useActionState(autosaveCustomerInfoWorkspaceAction, initialState);
  const [draftShippingAddress, setDraftShippingAddress] = useState(shippingAddress);
  const formRef = useRef<HTMLFormElement | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    const timer = setTimeout(() => {
      formRef.current?.requestSubmit();
    }, 700);

    return () => clearTimeout(timer);
  }, [draftShippingAddress]);

  return (
    <form ref={formRef} action={formAction} className="space-y-1">
      <input type="hidden" name="case_id" value={caseId} />
      <textarea
        id="shipping_address"
        name="shipping_address"
        rows={4}
        className="textarea"
        value={draftShippingAddress}
        onChange={(event) => setDraftShippingAddress(event.target.value)}
        onBlur={() => formRef.current?.requestSubmit()}
      />
      <p className="text-xs text-[#64748b]">
        {isPending ? "Saving..." : state.error ? `Save failed: ${state.error}` : state.savedAt ? "Saved just now" : "Autosave enabled"}
      </p>
      <p className="text-xs text-[#64748b]">Updates are stored only in this app and do not write back to QuickBooks.</p>
    </form>
  );
}
