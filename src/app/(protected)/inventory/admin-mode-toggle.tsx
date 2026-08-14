"use client";

import { useState } from "react";
import { lockInventoryAdminAction, unlockInventoryAdminAction } from "@/app/(protected)/inventory/actions";

export function AdminModeToggle({ unlocked }: { unlocked: boolean }) {
  const [promptOpen, setPromptOpen] = useState(false);

  if (unlocked) {
    return (
      <form action={lockInventoryAdminAction} className="flex items-center gap-2">
        <span className="rounded-full border border-[#fcd34d] bg-[#fffbeb] px-3 py-1 text-xs font-semibold text-[#92400e]">
          Admin mode on
        </span>
        <button type="submit" className="rounded-lg border border-[#d1d5db] px-3 py-1.5 text-xs font-semibold text-[#374151] transition hover:bg-[#f9fafb]">
          Exit
        </button>
      </form>
    );
  }

  if (!promptOpen) {
    return (
      <button
        type="button"
        onClick={() => setPromptOpen(true)}
        className="rounded-lg border border-[#d1d5db] px-3 py-1.5 text-xs font-semibold text-[#374151] transition hover:bg-[#f9fafb]"
      >
        Admin
      </button>
    );
  }

  return (
    <form action={unlockInventoryAdminAction} className="flex items-center gap-2">
      <input
        name="admin_code"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoFocus
        placeholder="Admin code"
        aria-label="Admin code"
        className="w-32 rounded-lg border border-[#d1d5db] px-3 py-1.5 text-xs"
      />
      <button type="submit" className="rounded-lg bg-[#111827] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#1f2937]">
        Unlock
      </button>
      <button
        type="button"
        onClick={() => setPromptOpen(false)}
        className="rounded-lg border border-[#d1d5db] px-3 py-1.5 text-xs font-semibold text-[#374151] transition hover:bg-[#f9fafb]"
      >
        Cancel
      </button>
    </form>
  );
}
