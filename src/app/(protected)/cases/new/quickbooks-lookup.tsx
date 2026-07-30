"use client";

import { useEffect, useRef, useState } from "react";

type Suggestion = {
  key: string;
  type: "invoice" | "customer";
  lookupQuery: string;
  primary: string;
  secondary?: string;
  invoiceNumber?: string;
  invoiceDate?: string | null;
  invoiceTotal?: number | null;
  paymentStatus?: string | null;
};

type SuggestionsResponse = {
  suggestions: Suggestion[];
};

export function QuickbooksLookup() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/quickbooks/suggestions?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });

        if (!response.ok) {
          setSuggestions([]);
          setOpen(false);
          return;
        }

        const data = (await response.json()) as SuggestionsResponse;
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
      clearTimeout(timer);
    };
  }, [query]);

  function selectSuggestion(suggestion: Suggestion) {
    setQuery(suggestion.lookupQuery);
    setOpen(false);
    if (inputRef.current) {
      inputRef.current.value = suggestion.lookupQuery;
    }
    inputRef.current?.form?.requestSubmit();
  }

  return (
    <div className="space-y-2">
      <div className="flex-1">
        <label htmlFor="lookup_query" className="label">Search QuickBooks</label>
        <input
          ref={inputRef}
          id="lookup_query"
          name="lookup_query"
          className="input h-11"
          placeholder="Start typing customer name, customer ID, or invoice number"
          value={query}
          onChange={(event) => {
            const nextQuery = event.target.value;
            setQuery(nextQuery);
            if (nextQuery.trim().length < 2) {
              setSuggestions([]);
              setOpen(false);
            }
          }}
          onFocus={() => setOpen(suggestions.length > 0)}
          autoComplete="off"
        />
      </div>

      {loading ? <p className="text-xs text-[#5a5a5a]">Searching QuickBooks matches...</p> : null}

      {open ? (
        <div className="rounded-md border border-[#d7d7d7] bg-white shadow-sm">
          <ul className="max-h-64 overflow-auto">
            {suggestions.map((suggestion) => (
              <li key={suggestion.key} className="border-b border-[#efefef] last:border-b-0">
                <button
                  type="button"
                  onClick={() => selectSuggestion(suggestion)}
                  className="w-full px-3 py-2 text-left hover:bg-[#f8f8f8]"
                >
                  <p className="text-sm font-semibold">{suggestion.primary}</p>
                  {suggestion.secondary ? <p className="text-xs text-[#5a5a5a]">{suggestion.secondary}</p> : null}
                  <p className="text-xs text-[#6a6a6a]">
                    {suggestion.type === "invoice" ? "Invoice" : "Customer"}
                    {suggestion.invoiceNumber ? ` • #${suggestion.invoiceNumber}` : ""}
                    {suggestion.invoiceDate ? ` • ${suggestion.invoiceDate}` : ""}
                    {suggestion.invoiceTotal != null ? ` • $${suggestion.invoiceTotal.toFixed(2)}` : ""}
                    {suggestion.paymentStatus ? ` • ${suggestion.paymentStatus}` : ""}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
