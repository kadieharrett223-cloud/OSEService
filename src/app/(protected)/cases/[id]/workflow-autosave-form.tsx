"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { autosaveWorkflowWorkspaceAction } from "@/app/(protected)/cases/[id]/actions";

type AutoSaveState = {
  ok: boolean;
  savedAt?: string;
  error?: string;
};

type AssigneeOption = {
  id: string;
  full_name: string | null;
};

type WorkflowAutosaveFormProps = {
  caseId: string;
  status: string;
  statusOptions: readonly string[];
  assigneeId: string;
  assignees: AssigneeOption[];
  nextAction: string;
  etaDate: string;
};

const initialState: AutoSaveState = { ok: true };

export function WorkflowAutosaveForm({
  caseId,
  status,
  statusOptions,
  assigneeId,
  assignees,
  nextAction,
  etaDate,
}: WorkflowAutosaveFormProps) {
  const [state, formAction, isPending] = useActionState(autosaveWorkflowWorkspaceAction, initialState);
  const [draftStatus, setDraftStatus] = useState(status);
  const [draftAssigneeId, setDraftAssigneeId] = useState(assigneeId);
  const [draftNextAction, setDraftNextAction] = useState(nextAction);
  const [draftEtaDate, setDraftEtaDate] = useState(etaDate);
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
  }, [draftStatus, draftAssigneeId, draftNextAction, draftEtaDate]);

  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="case_id" value={caseId} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label htmlFor="status" className="label">Current Status</label>
          <select
            id="status"
            name="status"
            className="select"
            value={draftStatus}
            onChange={(event) => setDraftStatus(event.target.value)}
            onBlur={() => formRef.current?.requestSubmit()}
          >
            {statusOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="assigned_employee_id" className="label">Assigned To</label>
          <select
            id="assigned_employee_id"
            name="assigned_employee_id"
            className="select"
            value={draftAssigneeId}
            onChange={(event) => setDraftAssigneeId(event.target.value)}
            onBlur={() => formRef.current?.requestSubmit()}
          >
            <option value="">Unassigned</option>
            {assignees.map((assignee) => (
              <option key={assignee.id} value={assignee.id}>{assignee.full_name ?? "Unknown"}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="eta_date" className="label">ETA</label>
          <input
            id="eta_date"
            name="eta_date"
            type="date"
            className="input"
            value={draftEtaDate}
            onChange={(event) => setDraftEtaDate(event.target.value)}
            onBlur={() => formRef.current?.requestSubmit()}
          />
        </div>
      </div>

      <div>
        <label htmlFor="next_action" className="label">Next Action</label>
        <select
          id="next_action"
          name="next_action"
          className="select"
          value={draftNextAction}
          onChange={(event) => setDraftNextAction(event.target.value)}
          onBlur={() => formRef.current?.requestSubmit()}
        >
          <option value="">Select next action</option>
          <option value="Order Replacement Part">Order Replacement Part</option>
          <option value="Waiting on Supplier">Waiting on Supplier</option>
          <option value="Waiting on Customer">Waiting on Customer</option>
          <option value="Schedule Technician">Schedule Technician</option>
          <option value="Email Customer">Email Customer</option>
          <option value="Close Case">Close Case</option>
        </select>
      </div>

      <div className="text-xs text-[#64748b]">
        {isPending ? "Saving..." : state.error ? `Save failed: ${state.error}` : state.savedAt ? "Saved just now" : "Autosave enabled"}
      </div>
    </form>
  );
}
