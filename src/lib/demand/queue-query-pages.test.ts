import { describe, expect, it, vi } from "vitest";
import { createQueueReadPool, fetchQueuePages } from "./queue-query-pages";

describe("queue query pagination", () => {
  it("returns every row exactly once across small pages", async () => {
    const rows = Array.from({ length: 241 }, (_, id) => ({ id }));
    const fetch = vi.fn(async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }));
    expect(await fetchQueuePages(fetch)).toEqual(rows);
    expect(fetch.mock.calls).toEqual([[0, 99], [100, 199], [200, 299]]);
  });
  it("retries the same timed-out page without duplicating results", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ data: null, error: { code: "57014", message: "statement timeout" } })
      .mockResolvedValueOnce({ data: [{ id: 1 }], error: null });
    expect(await fetchQueuePages(fetch)).toEqual([{ id: 1 }]);
    expect(fetch.mock.calls).toEqual([[0, 99], [0, 99]]);
  });
  it("fails rather than publishing a partial customer list when retry fails", async () => {
    const fetch = vi.fn().mockResolvedValue({ data: null, error: { code: "57014", message: "statement timeout" } });
    await expect(fetchQueuePages(fetch)).rejects.toThrow("statement timeout");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("parallel pages return exactly the same complete, ordered rows as serial pages", async () => {
    for (const length of [0, 99, 100, 241, 300, 1000, 2860]) {
      const rows = Array.from({ length }, (_, id) => ({ id, quantity: id % 7 }));
      const fetch = async (from: number, to: number) => {
        // Finish higher offsets sooner; result order must still be stable.
        for (let i = 0; i < (from % 300 === 100 ? 5 : 0); i++) await Promise.resolve();
        return { data: rows.slice(from, to + 1), error: null };
      };
      expect(await fetchQueuePages(fetch, 3)).toEqual(await fetchQueuePages(fetch));
      expect(await fetchQueuePages(fetch, 3)).toEqual(rows);
    }
  });
  it("retries only the failing parallel offset and does not duplicate quantities", async () => {
    const rows = Array.from({ length: 241 }, (_, id) => ({ id }));
    let failed = false;
    const fetch = vi.fn(async (from: number, to: number) => {
      if (from === 100 && !failed) {
        failed = true;
        return { data: null, error: { code: "57014", message: "statement timeout" } };
      }
      return { data: rows.slice(from, to + 1), error: null };
    });
    expect(await fetchQueuePages(fetch, 3)).toEqual(rows);
    expect(fetch.mock.calls.filter(([from]) => from === 100)).toHaveLength(2);
  });
  it("rejects a failed parallel window instead of using the successful pages alone", async () => {
    await expect(fetchQueuePages(async (from) => from === 200
      ? { data: null, error: { message: "read failed" } }
      : { data: Array.from({ length: 100 }, (_, id) => ({ id: from + id })), error: null }, 3)).rejects.toThrow("read failed");
  });
  it("limits all table and ID-batch reads together and releases slots after errors", async () => {
    const read = createQueueReadPool(4);
    let active = 0;
    let peak = 0;
    const results = await Promise.allSettled(Array.from({ length: 24 }, (_, id) => read(async () => {
      active++;
      peak = Math.max(peak, active);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      active--;
      if (id === 3) throw new Error("read failed");
      return id;
    })));
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results[23]).toEqual({ status: "fulfilled", value: 23 });
    expect(await read(async () => 42)).toBe(42);
  });
});
