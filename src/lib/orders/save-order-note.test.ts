import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(), from: vi.fn(), insert: vi.fn(), revalidate: vi.fn(), projection: vi.fn(),
  order: { id: "10000000-0000-4000-8000-000000000001" } as { id: string } | null,
  line: { id: "20000000-0000-4000-8000-000000000002" } as { id: string } | null,
  filters: [] as Array<[string, string, unknown]>,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.user }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ from: mocks.from }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/orders/orders-projection-cache", () => ({ revalidateOrdersProjection: mocks.projection }));
import { POST } from "@/app/api/orders/notes/route";

const orderId = "10000000-0000-4000-8000-000000000001";
const lineId = "20000000-0000-4000-8000-000000000002";
function request(fields: Record<string, string> = {}, origin = "https://occ.test") {
  const form = new FormData();
  for (const [key, value] of Object.entries({ orderId, message: "  Customer asked for dock hold.  ", ...fields })) form.set(key, value);
  return new Request("https://occ.test/api/orders/notes", { method: "POST", headers: { origin }, body: form });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.filters = [];
  mocks.order = { id: orderId }; mocks.line = { id: lineId };
  mocks.user.mockResolvedValue({ id: "30000000-0000-4000-8000-000000000003", fullName: "Samie" });
  mocks.insert.mockResolvedValue({ error: null });
  mocks.projection.mockImplementation(() => undefined);
  mocks.from.mockImplementation((table: string) => {
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { mocks.filters.push([table, key, value]); return query; },
      maybeSingle: async () => ({ data: table === "shipping_orders" ? mocks.order : table === "shipping_order_lines" ? mocks.line : { id: "30000000-0000-4000-8000-000000000003" }, error: null }),
      insert: mocks.insert,
    };
    return query;
  });
});
describe("direct order note save", () => {
  it("rejects unsigned-in and cross-origin writes before accessing the database", async () => {
    expect((await POST(request({}, "https://elsewhere.test"))).status).toBe(403);
    mocks.user.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("confirms only the committed audit note without redirecting or changing stock/order state", async () => {
    const response = await POST(request());
    const { note } = await response.json();
    expect(response.status).toBe(200); expect(response.headers.has("location")).toBe(false);
    expect(note).toMatchObject({ message: "Customer asked for dock hold.", author: "Samie" });
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: note.id, entity_type: "shipping_order", entity_id: orderId, action: "ORDER_NOTE_ADDED",
      details: expect.objectContaining({ message: note.message, note_text: note.message, author_name: "Samie", saved_at: note.savedAt, line_id: null }),
    }));
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["shipping_orders", "access_users", "audit_log"]);
  });
  it("checks item ownership before saving an item note", async () => {
    mocks.line = null;
    const response = await POST(request({ lineId, sku: "4PXL-10" }));
    expect(response.status).toBe(400);
    expect(mocks.filters).toContainEqual(["shipping_order_lines", "shipping_order_id", orderId]);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("rejects blank notes and missing orders without creating audit records", async () => {
    expect((await POST(request({ message: "  " }))).status).toBe(400);
    mocks.order = null;
    expect((await POST(request())).status).toBe(404);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("does not claim success or invalidate caches when the audit insert fails", async () => {
    mocks.insert.mockResolvedValue({ error: { message: "database unavailable" } });
    const response = await POST(request());
    expect(response.status).toBe(500); expect((await response.json()).note).toBeUndefined();
    expect(mocks.projection).not.toHaveBeenCalled();
  });
  it("does not report a committed note as failed if cache invalidation fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.projection.mockImplementation(() => { throw new Error("cache unavailable"); });
    const response = await POST(request());
    expect(response.status).toBe(200); expect((await response.json()).note.message).toBe("Customer asked for dock hold.");
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
