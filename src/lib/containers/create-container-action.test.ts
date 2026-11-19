import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  insertResult: {} as { data: { id: string } | null; error: { code: string } | null },
  existing: { id: "saved-266" } as { id: string } | null,
  manifestInsert: vi.fn(),
  headerInsert: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: vi.fn(async () => ({ id: "employee" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock("@/lib/containers/product-options", () => ({ loadContainerProductOptions: async () => [{ id: "lift", sku: "LIFT", name: "Lift" }] }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: () => ({
  from(table: string) {
    if (table === "container_lines") return { insert: state.manifestInsert };
    if (table !== "containers") throw new Error(`Unexpected write: ${table}`);
    return {
      insert(payload: unknown) { state.headerInsert(payload); return { select: () => ({ single: async () => state.insertResult }) }; },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.existing, error: null }) }) }),
      delete: () => ({ eq: state.cleanup }),
    };
  },
}) }));
import { createContainerAction } from "@/app/(protected)/containers/actions";

function form() {
  const data = new FormData();
  data.set("container_number", "266");
  data.set("supplier", "HL");
  data.append("product_id", "lift"); data.append("product_qty", "10");
  return data;
}

describe("container save retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.existing = { id: "saved-266" };
    state.insertResult = { data: null, error: { code: "23505" } };
    state.manifestInsert.mockResolvedValue({ error: null });
    state.cleanup.mockResolvedValue({ error: null });
  });

  it("opens the existing record on a duplicate without replaying or replacing its manifest", async () => {
    await expect(createContainerAction(form())).rejects.toThrow(/REDIRECT:\/containers\/saved-266\?success=/);
    expect(state.manifestInsert).not.toHaveBeenCalled();
    expect(state.headerInsert).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the duplicate record cannot be verified", async () => {
    state.existing = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createContainerAction(form())).rejects.toThrow(/Check%20the%20Containers%20list/);
    expect(state.manifestInsert).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("does not blindly retry an uncertain database outcome", async () => {
    state.insertResult = { data: null, error: { code: "TIMEOUT" } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createContainerAction(form())).rejects.toThrow(/Could%20not%20confirm/);
    expect(state.headerInsert).toHaveBeenCalledTimes(1);
    expect(state.manifestInsert).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("saves a new manifest once and opens its detail for immediate review", async () => {
    state.insertResult = { data: { id: "new-267" }, error: null };
    await expect(createContainerAction(form())).rejects.toThrow("REDIRECT:/containers/new-267?success=Container+added");
    expect(state.manifestInsert).toHaveBeenCalledExactlyOnceWith([
      { container_id: "new-267", product_id: "lift", ordered_qty: 10, on_order_qty: 10, received_qty: 0 },
    ]);
  });

  it("rejects invalid quantities before creating a container", async () => {
    const invalid = form(); invalid.set("product_qty", "1.5");
    await expect(createContainerAction(invalid)).rejects.toThrow(/REDIRECT:\/containers\?error=/);
    expect(state.headerInsert).not.toHaveBeenCalled();
  });

  it("cleans up only its newly created header when the manifest fails", async () => {
    state.insertResult = { data: { id: "synthetic-new" }, error: null };
    state.manifestInsert.mockResolvedValue({ error: { code: "FAIL" } });
    await expect(createContainerAction(form())).rejects.toThrow(/No%20container%20was%20created/);
    expect(state.cleanup).toHaveBeenCalledExactlyOnceWith("id", "synthetic-new");
  });

  it("warns against recreating a saved empty header if cleanup fails", async () => {
    state.insertResult = { data: { id: "synthetic-new" }, error: null };
    state.manifestInsert.mockResolvedValue({ error: { code: "FAIL" } });
    state.cleanup.mockResolvedValue({ error: { code: "FAIL" } });
    await expect(createContainerAction(form())).rejects.toThrow(/Do%20not%20recreate/);
    expect(state.headerInsert).toHaveBeenCalledTimes(1);
  });
});
