"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function ArrivalDatesForm({ containerId, portDate, confirmedDate, estimatedDate }: {
  containerId: string; portDate: string; confirmedDate: string; estimatedDate: string;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setMessage("");
    setError("");
    const body = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/containers/arrival-dates", { method: "POST", body });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Could not save arrival dates.");
      setMessage("Arrival dates saved.");
      startRefresh(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save arrival dates. Please try again.");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return <form onSubmit={save} className="mt-5 border-t border-[#e5e7eb] pt-4">
    <input type="hidden" name="container_id" value={containerId} />
    <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[#6b7280]">Update Arrival Dates</p>
    <p className="mt-1 text-xs text-[#6b7280]">Drives Next Arrival on the Inventory page.</p>
    <fieldset disabled={saving || refreshing} className="mt-3 space-y-3">
      <div><label className="label" htmlFor="port_date">Port Date</label><input id="port_date" name="port_date" type="date" className="input" defaultValue={portDate} /></div>
      <div><label className="label" htmlFor="eta_confirmed_date">Confirmed ETA</label><input id="eta_confirmed_date" name="eta_confirmed_date" type="date" className="input" defaultValue={confirmedDate} /></div>
      <div><label className="label" htmlFor="eta_estimated_date">Estimated ETA</label><input id="eta_estimated_date" name="eta_estimated_date" type="date" className="input" defaultValue={estimatedDate} /></div>
    </fieldset>
    <button disabled={saving || refreshing} aria-busy={saving} type="submit" className="mt-4 w-full rounded-lg bg-[#111827] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#1f2937] disabled:opacity-60">
      {saving ? "Saving…" : refreshing ? "Saved — Updating…" : "Save Dates"}
    </button>
    <p role="status" aria-live="polite" className="mt-2 text-sm text-green-800">{message}{refreshing ? " Updating customer coverage…" : ""}</p>
    {error ? <p role="alert" className="mt-2 text-sm text-red-800">{error}</p> : null}
  </form>;
}
