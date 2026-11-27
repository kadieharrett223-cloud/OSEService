import { expect, it } from "vitest";
import { containerArrivalSortKey, containerSummaryUnits, savedContainerArrival } from "./arrival-display";

it("sorts the single ETA chronologically across legacy date fields, with pending last", () => {
  const rows = [
    { id: "pending", eta_confirmed_date: null, eta_estimated_date: null },
    { id: "estimate", eta_confirmed_date: null, eta_estimated_date: "2026-12-01" },
    { id: "confirmed", eta_confirmed_date: "2027-02-01", eta_estimated_date: null },
    { id: "invalid", eta_confirmed_date: "invalid", eta_estimated_date: null },
  ];
  expect(rows.sort((a,b) => containerArrivalSortKey(a).localeCompare(containerArrivalSortKey(b))).map(r=>r.id)).toEqual(["estimate", "confirmed", "pending", "invalid"]);
});

it("leaves warehouse ETA pending when only entry and port milestones exist", () => {
  const container = { entered_date: "2026-11-18", us_port_eta_date: "2027-01-06", eta_confirmed_date: null, eta_estimated_date: null };
  expect(savedContainerArrival(container)).toEqual({ date: null, isEstimate: false });
  expect(savedContainerArrival({ ...container, eta_estimated_date: "2027-01-15" })).toEqual({ date: "2027-01-15", isEstimate: true });
  expect(savedContainerArrival({ ...container, eta_confirmed_date: "2027-01-20", eta_estimated_date: "2027-01-15" })).toEqual({ date: "2027-01-20", isEstimate: false });
});

it("uses actual received units for receipt history and remaining units for incoming supply", () => {
  const lines = [{ on_order_qty: 0, received_qty: 40 }, { on_order_qty: 0, received_qty: 31 }, { on_order_qty: 0, received_qty: 10 }];
  expect(containerSummaryUnits("RECEIVED", lines)).toBe(81);
  expect(containerSummaryUnits("PRODUCTION", [{ on_order_qty: 10, received_qty: 3 }])).toBe(7);
});
