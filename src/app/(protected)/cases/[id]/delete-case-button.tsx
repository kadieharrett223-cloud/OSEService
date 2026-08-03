"use client";

import { useRef, type MouseEvent } from "react";
import { deleteCaseAction } from "@/app/(protected)/cases/[id]/actions";

export function DeleteCaseButton({ caseId }: { caseId: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    const confirmationCode = window.prompt("Type 9822 to permanently delete this case.");

    if (confirmationCode === null) {
      return;
    }

    if (confirmationCode.trim() !== "9822") {
      window.alert("The delete code was incorrect.");
      return;
    }

    if (codeRef.current) {
      codeRef.current.value = confirmationCode.trim();
    }

    formRef.current?.requestSubmit();
  }

  return (
    <form ref={formRef} action={deleteCaseAction} className="flex items-center gap-2">
      <input type="hidden" name="case_id" value={caseId} />
      <input ref={codeRef} type="hidden" name="confirmation_code" />
      <button type="button" onClick={handleClick} className="btn-danger text-xs">
        Delete?
      </button>
    </form>
  );
}
