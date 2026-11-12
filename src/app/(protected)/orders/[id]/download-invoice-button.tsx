"use client";

import { useRef, useState } from "react";

export function DownloadInvoiceButton({ orderId }: { orderId: string }) {
  const busy = useRef(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    if (busy.current) return;
    busy.current = true;
    setDownloading(true);
    setError("");
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/invoice`, { cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Could not download the invoice. Please try again.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "Invoice.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not download the invoice."); }
    finally { busy.current = false; setDownloading(false); }
  }
  return <div>
    <button type="button" className="btn-secondary inline-flex items-center gap-2" disabled={downloading} aria-busy={downloading} onClick={download}>
      {downloading ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
      {downloading ? "Downloading…" : "Download Invoice"}
    </button>
    {error ? <p role="alert" className="mt-1 max-w-sm text-sm text-red-700">{error}</p> : null}
  </div>;
}
