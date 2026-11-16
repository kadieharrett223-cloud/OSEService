import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/app/(protected)/orders/actions", () => ({ updateOrderLineAssignmentAction: async () => {} }));
vi.mock("@/app/(protected)/orders/[id]/assignment-submit-button", () => ({ AssignmentSubmitButton: () => null }));
import { SourceAssignmentForm } from "@/app/(protected)/orders/[id]/source-assignment-form";

it("renders container 264's saved January 27 ETA in the actual order picker", () => {
  vi.stubGlobal("React", React);
  const html = renderToStaticMarkup(React.createElement(SourceAssignmentForm, {
    orderId: "order", lineId: "line", remainingQty: 1, qtyAssignedDefault: 1,
    defaultSource: "CONTAINER", supplier: "", reference: "", tracking: "", notes: "",
    containers: [{ id: "container", container_number: "264", lifecycle_status: "ORDERED", eta_confirmed_date: null, eta_estimated_date: "2027-01-27", available_qty: 18 }],
  }));
  expect(html).toContain("264 · 18 available · ETA Jan 27, 2027");
  expect(html).not.toContain("Jan 26");
  vi.unstubAllGlobals();
});
