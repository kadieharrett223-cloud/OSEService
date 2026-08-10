"use client";

import { useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import { deleteCaseAction } from "@/app/(protected)/cases/[id]/actions";

export function DeleteCaseButton({ caseId }: { caseId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function handleOpenConfirm(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    setConfirmationCode("");
    setErrorMessage("");
    setIsConfirmOpen(true);
  }

  function handleCodeChange(event: ChangeEvent<HTMLInputElement>) {
    setConfirmationCode(event.target.value);
    if (errorMessage) setErrorMessage("");
  }

  function handleConfirmDelete() {
    const trimmedCode = confirmationCode.trim();

    if (!trimmedCode) {
      setErrorMessage("Enter the admin code to continue.");
      return;
    }

    if (codeRef.current) {
      codeRef.current.value = trimmedCode;
    }

    setIsSubmitting(true);
    formRef.current?.requestSubmit();
  }

  function handleCancel() {
    setIsConfirmOpen(false);
    setConfirmationCode("");
    setErrorMessage("");
  }

  return (
    <>
      <form ref={formRef} action={deleteCaseAction} className="flex items-center gap-2">
        <input type="hidden" name="case_id" value={caseId} />
        <input ref={codeRef} type="hidden" name="confirmation_code" />
        <button type="button" onClick={handleOpenConfirm} className="btn-danger text-xs" disabled={isSubmitting}>
          Delete?
        </button>
      </form>

      {isConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-sm rounded-xl border border-[#e7eaef] bg-white p-4 shadow-lg">
            <p className="text-sm font-semibold text-[#121826]">Permanently delete this case?</p>
            <p className="mt-2 text-sm text-[#5a5a5a]">Enter the secret code to delete this case and all attachments.</p>
            <input
              value={confirmationCode}
              onChange={handleCodeChange}
              className="mt-3 w-full rounded-md border border-[#d0d7de] px-3 py-2 text-sm"
              placeholder="Secret code"
              autoFocus
            />
            {errorMessage ? <p className="mt-2 text-sm text-[#b20610]">{errorMessage}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={handleCancel} className="btn-secondary text-xs">
                Cancel
              </button>
              <button type="button" onClick={handleConfirmDelete} className="btn-danger text-xs" disabled={isSubmitting}>
                {isSubmitting ? "Deleting..." : "Confirm Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
