"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { autosaveIssueDetailsWorkspaceAction } from "@/app/(protected)/cases/[id]/actions";

type AutoSaveState = {
  ok: boolean;
  savedAt?: string;
  error?: string;
};

type IssueDetailsAutosaveFormProps = {
  caseId: string;
  caseType: string;
  priority: string;
  issueDescription: string;
  caseTypeOptions: readonly string[];
  priorityOptions: readonly string[];
};

const initialState: AutoSaveState = { ok: true };

export function IssueDetailsAutosaveForm({
  caseId,
  caseType,
  priority,
  issueDescription,
  caseTypeOptions,
  priorityOptions,
}: IssueDetailsAutosaveFormProps) {
  const [state, formAction, isPending] = useActionState(autosaveIssueDetailsWorkspaceAction, initialState);
  const [draftCaseType, setDraftCaseType] = useState(caseType);
  const [draftPriority, setDraftPriority] = useState(priority);
  const [draftIssueDescription, setDraftIssueDescription] = useState(issueDescription);
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
  }, [draftCaseType, draftPriority, draftIssueDescription]);

  return (
    <form ref={formRef} action={formAction} className="mt-3 space-y-3">
      <input type="hidden" name="case_id" value={caseId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="case_type" className="label">Issue Category</label>
          <select
            id="case_type"
            name="case_type"
            className="select"
            value={draftCaseType}
            onChange={(event) => setDraftCaseType(event.target.value)}
            onBlur={() => formRef.current?.requestSubmit()}
          >
            {caseTypeOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="priority" className="label">Priority</label>
          <select
            id="priority"
            name="priority"
            className="select"
            value={draftPriority}
            onChange={(event) => setDraftPriority(event.target.value)}
            onBlur={() => formRef.current?.requestSubmit()}
          >
            {priorityOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="issue_description" className="label">Issue Description</label>
        <textarea
          id="issue_description"
          name="issue_description"
          rows={8}
          className="textarea"
          required
          value={draftIssueDescription}
          onChange={(event) => setDraftIssueDescription(event.target.value)}
          onBlur={() => formRef.current?.requestSubmit()}
        />
      </div>
      <div className="text-xs text-[#64748b]">
        {isPending ? "Saving..." : state.error ? `Save failed: ${state.error}` : state.savedAt ? "Saved just now" : "Autosave enabled"}
      </div>
    </form>
  );
}
