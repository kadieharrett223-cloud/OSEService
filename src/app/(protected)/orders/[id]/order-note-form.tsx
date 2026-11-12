"use client";

import { useRef, useState, type FormEvent } from "react";
import type { SavedOrderNote } from "@/lib/orders/save-order-note";

export function OrderNoteForm({ orderId, lineId, sku, initialNotes }: {
  orderId: string; lineId?: string; sku?: string; initialNotes?: SavedOrderNote[];
}) {
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<SavedOrderNote[]>([]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setPending(true); setError(""); setStatus("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/orders/notes", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok || !data.note) throw new Error(data.error || "Could not confirm the save. Check the order notes before trying again.");
      setSaved(notes => [data.note, ...notes]);
      setMessage(""); setStatus("Note saved.");
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== "Failed to fetch" ? cause.message : "Connection interrupted. Your text has been kept. Check the order notes before trying again.");
    } finally { saving.current = false; setPending(false); }
  }
  const notes = [...saved, ...(initialNotes ?? []).filter(n => !saved.some(s => s.id === n.id))];
  return <div>
    <form onSubmit={submit} className="mt-4 space-y-3" aria-busy={pending}>
      <input type="hidden" name="orderId" value={orderId} />
      {lineId ? <input type="hidden" name="lineId" value={lineId} /> : null}
      {sku ? <input type="hidden" name="sku" value={sku} /> : null}
      <textarea name="message" aria-label={lineId ? "Item note" : "Order note"} rows={4} required disabled={pending} value={message} onChange={event => setMessage(event.target.value)} className="textarea w-full disabled:opacity-75" placeholder={lineId ? "Add an item-specific note" : "Add a note..."} />
      <div className="flex justify-end">
        <button className={`${lineId ? "btn-secondary" : "btn-primary"} inline-flex items-center gap-2 disabled:cursor-wait disabled:opacity-75`} type="submit" disabled={pending || !message.trim()}>
          {pending ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" /> : null}
          {pending ? "Saving note…" : "Save Note"}
        </button>
      </div>
      <p role="status" aria-live="polite" className="text-sm text-[#475569]">{pending ? "Saving your note. Please wait and keep this page open." : status}</p>
      {error ? <p role="alert" className="text-sm text-[#b91c1c]">{error}</p> : null}
    </form>
    <div className="mt-4 space-y-3">
      {initialNotes && notes.length === 0 ? <p className="text-sm text-[#6b7280]">No order notes yet.</p> : null}
      {notes.map(note => <div key={note.id} className="rounded-lg border border-[#eef2f7] bg-[#fafbfc] p-3 text-sm">
        <p className="font-semibold text-[#111827]">{new Date(note.savedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} — {note.author}{note.sku ? ` · ${note.sku}` : ""}</p>
        <p className="mt-1 whitespace-pre-wrap text-[#5a5a5a]">{note.message}</p>
      </div>)}
    </div>
  </div>;
}
