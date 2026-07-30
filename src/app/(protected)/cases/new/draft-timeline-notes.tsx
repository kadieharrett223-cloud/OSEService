"use client";

import { useMemo, useState } from "react";

type DraftNote = {
  id: string;
  content: string;
  createdAt: string;
};

export function DraftTimelineNotes() {
  const [draftValue, setDraftValue] = useState("");
  const [notes, setNotes] = useState<DraftNote[]>([]);

  const canAdd = draftValue.trim().length > 0;

  function addNote() {
    const trimmed = draftValue.trim();
    if (!trimmed) return;

    setNotes((current) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        content: trimmed,
        createdAt: new Date().toISOString(),
      },
      ...current,
    ]);
    setDraftValue("");
  }

  function removeNote(noteId: string) {
    setNotes((current) => current.filter((note) => note.id !== noteId));
  }

  const countLabel = useMemo(() => {
    if (notes.length === 0) return "No draft notes yet";
    if (notes.length === 1) return "1 draft note queued";
    return `${notes.length} draft notes queued`;
  }, [notes.length]);

  return (
    <div className="space-y-3">
      <textarea
        id="internal_notes"
        rows={4}
        className="textarea"
        value={draftValue}
        onChange={(event) => setDraftValue(event.target.value)}
        placeholder="Add internal timeline note"
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#64748b]">{countLabel}</p>
        <button type="button" className="btn-secondary" onClick={addNote} disabled={!canAdd}>
          Add Note
        </button>
      </div>

      {notes.length > 0 ? (
        <div className="space-y-2 rounded-md border border-[#edf0f4] bg-[#fafbfc] p-3">
          {notes.map((note) => (
            <div key={note.id} className="rounded-md border border-[#e5e7eb] bg-white p-2 text-sm">
              <input type="hidden" name="draft_internal_notes" value={note.content} />
              <p className="whitespace-pre-wrap text-[#334155]">{note.content}</p>
              <div className="mt-1 flex items-center justify-between text-xs text-[#64748b]">
                <span>{new Date(note.createdAt).toLocaleString()}</span>
                <button type="button" className="text-[#b20610]" onClick={() => removeNote(note.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
