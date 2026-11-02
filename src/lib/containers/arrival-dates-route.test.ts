import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: { id: "staff" } as { id: string } | null, data: { id: "saved" } as { id: string } | null, error: null as unknown, writes: [] as unknown[], paths: [] as string[], projections: 0 }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: async () => state.user }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => state.paths.push(path) }));
vi.mock("@/lib/orders/orders-projection-cache", () => ({ revalidateOrdersProjection: () => { state.projections++; } }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({ from: (table: string) => ({ update: (values: unknown) => {
  state.writes.push({ table, values });
  return { eq: (key: string, value: string) => { state.writes.push({ key, value }); return { select: () => ({ maybeSingle: async () => ({ data: state.data, error: state.error }) }) }; } };
} }) }) }));
import { POST } from "@/app/api/containers/arrival-dates/route";
const id = "dfab3deb-d818-47b9-8474-8d1eb7ccfe1a";
function request(overrides: Record<string, string> = {}, origin = "https://ose-service.vercel.app") {
  const body = new FormData();
  for (const [key, value] of Object.entries({ container_id: id, port_date: "2026-12-23", eta_confirmed_date: "", eta_estimated_date: "2026-12-30", ...overrides })) body.set(key, value);
  return new Request("https://ose-service.vercel.app/api/containers/arrival-dates", { method: "POST", headers: { origin }, body });
}
beforeEach(() => { state.user = { id: "staff" }; state.data = { id }; state.error = null; state.writes = []; state.paths = []; state.projections = 0; });
it("acknowledges date-only persistence without redirecting or loading customer coverage", async () => {
  const result = await POST(request());
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ success: true });
  expect(result.headers.get("location")).toBeNull();
  expect(state.writes).toEqual([{ table: "containers", values: { port_date: "2026-12-23", eta_confirmed_date: null, eta_estimated_date: "2026-12-30" } }, { key: "id", value: id }]);
  expect(state.projections).toBe(1);
  expect(state.paths).toEqual(expect.arrayContaining([`/containers/${id}`, "/inventory", "/orders", "/shipping-groups"]));
});
it("requires a signed-in user and a same-origin request before touching data", async () => {
  expect((await POST(request({}, "https://another.example"))).status).toBe(403);
  state.user = null;
  expect((await POST(request())).status).toBe(401);
  expect(state.writes).toEqual([]);
});
it.each<Record<string, string>>([{ port_date: "2026-02-30" }, { eta_estimated_date: "bad" }, { container_id: "bad" }])("rejects invalid data without writing: %o", async (input) => {
  expect((await POST(request(input))).status).toBe(400);
  expect(state.writes).toEqual([]);
});
it("never reports success when the container is missing or the update fails", async () => {
  state.data = null;
  expect((await POST(request())).status).toBe(404);
  state.error = { message: "database failed" };
  expect((await POST(request())).status).toBe(500);
  expect(state.projections).toBe(0);
  expect(state.paths).toEqual([]);
});
