import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), db: vi.fn(), pdf: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: mocks.db }));
vi.mock("@/lib/quickbooks/integration", () => ({ downloadQuickbooksInvoicePdf: mocks.pdf }));
import { GET } from "./route";
const id = "8efe9524-a34e-4f5b-8f86-bdcb5d20cc33";
const run = (value = id) => GET(new Request(`https://example.com/api/orders/${value}/invoice`), { params: Promise.resolve({ id: value }) });
let lookups: Array<[string, string, unknown]>;
beforeEach(() => {
  vi.resetAllMocks();
  lookups = [];
  mocks.user.mockResolvedValue({ id: "employee" });
  mocks.pdf.mockResolvedValue(new TextEncoder().encode("%PDF-1.4 synthetic fixture").buffer);
  mocks.db.mockReturnValue({ from: (table: string) => {
    const chain = { select: () => chain, eq: (key: string, value: unknown) => { lookups.push([table, key, value]); return chain; }, maybeSingle: async () => ({ data: table === "shipping_orders" ? { source_invoice_id: "linked-invoice" } : { qbo_invoice_id: "20613", invoice_number: '9447/"unsafe' }, error: null }) };
    return chain;
  } });
});
describe("order invoice download", () => {
  it("requires authentication before reading invoice data", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await run()).status).toBe(401);
    expect(mocks.db).not.toHaveBeenCalled();
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
  it("downloads only the opened order's linked QBO transaction and supplies a safe attachment name", async () => {
    const response = await run();
    expect(lookups).toEqual([["shipping_orders", "id", id], ["qbo_invoices", "id", "linked-invoice"]]);
    expect(mocks.pdf).toHaveBeenCalledExactlyOnceWith("20613");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="Invoice-9447__unsafe.pdf"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(await response.text()).toBe("%PDF-1.4 synthetic fixture");
  });
  it("rejects invalid order identifiers", async () => {
    expect((await run("invalid")).status).toBe(400);
    expect(mocks.db).not.toHaveBeenCalled();
  });
  it("does not substitute another invoice when the order has no link", async () => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { source_invoice_id: null }, error: null }) };
    mocks.db.mockReturnValue({ from: () => chain });
    expect((await run()).status).toBe(404);
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
  it("returns a clear failure without returning upstream secrets or downloading an error as a PDF", async () => {
    mocks.pdf.mockRejectedValue(new Error("upstream secret"));
    const response = await run();
    expect(response.status).toBe(502);
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(await response.text()).not.toContain("upstream secret");
  });
});
