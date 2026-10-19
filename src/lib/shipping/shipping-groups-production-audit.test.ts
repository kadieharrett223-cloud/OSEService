import { expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
// Explicit opt-in only. Real SELECTs; no writes or automatic QBO refresh.
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: "verification-only" }),
}));
import ShippingGroupsPage from "@/app/(protected)/shipping-groups/page";
import { loadShippingGroupCandidates } from "./shipping-groups-loader";
import { groupShippingCandidates } from "./shipping-groups";
it.skipIf(process.env.RUN_SHIPPING_GROUP_READONLY_AUDIT !== "1")(
  "renders recommendations from actual live read-only data",
  async () => {
    vi.stubGlobal("React", React);
    const data = await loadShippingGroupCandidates();
    const result = groupShippingCandidates(data.candidates, 120, 7, new Date());
    const allIds = [
      ...result.groups.flatMap((g) => g.orders),
      ...result.review,
    ].map((o) => o.orderId);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(
      data.candidates.every((o) => o.lifts.every((l) => l.quantity > 0)),
    ).toBe(true);
    const html = renderToStaticMarkup(
      await ShippingGroupsPage({ searchParams: Promise.resolve({}) }),
    );
    expect(html).toContain("Suggested Shipping Groups");
    expect(html).not.toContain("Create Shipment");
    console.log(
      JSON.stringify({
        orders: data.candidates.length,
        lifts: data.candidates
          .flatMap((o) => o.lifts)
          .reduce((s, l) => s + l.quantity, 0),
        geographicGroups: result.groups.length,
        addressReview: result.review.length,
        warnings: data.warnings,
        rendered: true,
      }),
    );
  },
  120000,
);
