import { describe, expect, it, vi } from "vitest";
import { fetchQueuePages } from "./queue-query-pages";

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
});
