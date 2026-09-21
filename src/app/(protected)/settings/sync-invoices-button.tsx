"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type SyncResult = { message?: string; error?: string };

export function SyncInvoicesButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [isSyncing, setIsSyncing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const isDisabled = Boolean(disabled || isSyncing);

  async function syncInvoices() {
    setIsSyncing(true);
    setStatus("Contacting QuickBooks and rebuilding customer lists…");

    try {
      const response = await fetch("/api/settings/sync-quickbooks", { method: "POST" });
      // A platform timeout or proxy error can be HTML instead of our normal
      // JSON contract. Never expose a JSON parser error to the operator.
      const rawResult = await response.text();
      let result: SyncResult = {};
      try {
        result = rawResult ? JSON.parse(rawResult) as SyncResult : {};
      } catch {
        const timeout = response.status === 504 || /timed out|timeout/i.test(rawResult);
        throw new Error(timeout
          ? "QuickBooks sync exceeded the server time limit. No final sync result was saved; please retry."
          : `QuickBooks sync returned an unexpected server response (${response.status || "unknown status"}).`);
      }
      if (!response.ok) throw new Error(result.error ?? "QuickBooks sync failed.");
      setStatus(result.message ?? "QuickBooks sync complete.");
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "QuickBooks sync failed.");
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="btn-secondary min-w-40"
        disabled={isDisabled}
        onClick={syncInvoices}
        aria-busy={isSyncing}
      >
        {isSyncing ? "Syncing QuickBooks…" : "Sync Invoices"}
      </button>
      {status ? <p className="max-w-sm text-xs text-[#5a5a5a]" role="status">{status}</p> : null}
    </div>
  );
}
