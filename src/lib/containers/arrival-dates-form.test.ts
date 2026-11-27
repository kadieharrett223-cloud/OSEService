import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { ArrivalDatesForm } from "@/app/(protected)/containers/[id]/arrival-dates-form";
it("shows exactly two arrival date controls and preserves the existing effective ETA", () => {
  vi.stubGlobal("React", React);
  try {
    const html = renderToStaticMarkup(React.createElement(ArrivalDatesForm, {containerId: "container", portDate: "2026-12-02", confirmedDate: "2026-12-30", estimatedDate: "2027-01-15"}));
    expect((html.match(/type="date"/g) ?? []).length).toBe(2);
    expect(html).toContain("ETA Date");
    expect(html).toContain("Confirmed Port Arrival");
    expect(html).toContain('name="eta_date"');
    expect(html).toContain('value="2026-12-30"');
    expect(html).not.toContain("Confirmed ETA");
    expect(html).not.toContain("Estimated ETA");
  } finally { vi.unstubAllGlobals(); }
});
