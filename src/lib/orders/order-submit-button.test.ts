import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const state = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", () => ({ useFormStatus: () => ({ pending: state.pending }) }));
import { OrderSubmitButton } from "@/app/(protected)/orders/new/order-submit-button";
const render = (label = "Open in New Orders", pendingLabel = "Opening…") => renderToStaticMarkup(createElement(OrderSubmitButton, { label, pendingLabel }));
beforeEach(() => { state.pending = false; });

it("shows the normal action with an enabled button while idle", () => {
  const html = render();
  expect(html).toContain("Open in New Orders");
  expect(html).toContain('aria-busy="false"');
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain("animate-spin");
});
it("shows a spinner and Opening status and prevents repeat submission while pending", () => {
  state.pending = true;
  const html = render();
  expect(html).toContain("Opening…");
  expect(html).toContain("animate-spin");
  expect(html).toContain('disabled=""');
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('role="status"');
});
it("shows Adding for imports and returns to the original enabled label when finished", () => {
  state.pending = true;
  expect(render("Add With Payment Hold", "Adding…")).toContain("Adding…");
  state.pending = false;
  const html = render("Add With Payment Hold", "Adding…");
  expect(html).toContain("Add With Payment Hold");
  expect(html).not.toContain('disabled=""');
});
it("keeps the existing server action, invoice identity and payment-hold inputs intact", () => {
  const source = readFileSync("src/app/(protected)/orders/new/page.tsx", "utf8");
  expect(source).toContain('<form action={createOrderFromQuickbooksInvoiceAction}>');
  expect(source).toContain('name="qbo_invoice_id" value={invoice.id}');
  expect(source).toContain('name="payment_hold" value="true"');
  expect(source).toContain("<OrderSubmitButton");
});
