"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type InvoiceSuggestion = {
  id: string;
  invoiceNumber: string;
  quickbooksInvoiceId: string | null;
  customerId: string | null;
  invoiceDate: string | null;
  invoiceTotal: number | null;
  paymentStatus: string | null;
  label: string;
};

export function InstallationInvoiceTypeahead({
  initialValue,
  onSelect,
  targetInputId,
  submitFormId,
}: {
  initialValue?: string;
  onSelect: (selection: InvoiceSuggestion) => void;
  targetInputId?: string;
  submitFormId?: string;
}) {
  const [query, setQuery] = useState(initialValue ?? "");
  const [suggestions, setSuggestions] = useState<InvoiceSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery(initialValue ?? "");
  }, [initialValue]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/quickbooks/installation-suggestions?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          setSuggestions([]);
          setOpen(false);
          return;
        }

        const data = await response.json() as { suggestions?: InvoiceSuggestion[] };
        setSuggestions(data.suggestions ?? []);
        setOpen((data.suggestions ?? []).length > 0);
      } catch {
        setSuggestions([]);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }, 220);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const helperText = useMemo(() => {
    if (!query.trim()) return "Start typing to see matching invoices";
    if (loading) return "Searching invoices...";
    if (suggestions.length === 0) return "No matching invoices found";
    return `${suggestions.length} invoice match${suggestions.length === 1 ? "" : "es"}`;
  }, [loading, query, suggestions.length]);

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor="invoice_number_lookup" className="label">Invoice Number</label>
      <input
        id="invoice_number_lookup"
        name="invoice_number"
        required
        className="input"
        placeholder="Enter invoice number"
        value={query}
        onChange={(event) => {
          const nextValue = event.target.value;
          setQuery(nextValue);

          if (targetInputId) {
            const targetInput = document.getElementById(targetInputId) as HTMLInputElement | null;
            if (targetInput) {
              targetInput.value = nextValue;
            }
          }
        }}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        autoComplete="off"
      />

      <p className="mt-1 text-xs text-[#64748b]">{helperText}</p>

      {open ? (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-[#e5e7eb] bg-white shadow-lg">
          <ul className="max-h-64 overflow-auto">
            {suggestions.map((suggestion) => (
              <li key={`${suggestion.id}-${suggestion.invoiceNumber}`}>
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-[#f8fafc]"
                  onClick={() => {
                    const nextValue = suggestion.invoiceNumber || suggestion.label;
                    setQuery(nextValue);
                    setOpen(false);

                    if (targetInputId) {
                      const targetInput = document.getElementById(targetInputId) as HTMLInputElement | null;
                      if (targetInput) {
                        targetInput.value = nextValue;
                      }
                    }

                    onSelect(suggestion);

                    if (submitFormId) {
                      const form = document.getElementById(submitFormId) as HTMLFormElement | null;
                      if (form) {
                        form.requestSubmit();
                      }
                    }
                  }}
                >
                  <span>
                    <span className="block text-sm font-semibold text-[#121826]">{suggestion.invoiceNumber || suggestion.label}</span>
                    <span className="block text-xs text-[#64748b]">
                      {suggestion.quickbooksInvoiceId ? `QuickBooks ID: ${suggestion.quickbooksInvoiceId}` : "Invoice match"}
                    </span>
                  </span>
                  <span className="text-xs text-[#64748b]">
                    {suggestion.invoiceDate ?? ""}
                    {suggestion.invoiceTotal != null ? ` • $${suggestion.invoiceTotal.toFixed(2)}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
