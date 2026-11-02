import { describe, expect, it, vi } from "vitest";
import { loadInventoryStockHistory } from "./stock-history-read";

function database(rows: Array<{ product_id: string; bucket: string; delta: number; source_type: string }>, failAt?: number) {
  const query = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn(async (from: number, to: number) => from === failAt
      ? { data: null, error: { message: "Stock history unavailable" } }
      : { data: rows.slice(from, to + 1), error: null }),
  };
  return { query, client: { from: vi.fn(() => query) } as unknown as Parameters<typeof loadInventoryStockHistory>[0] };
}

describe("complete stock history", () => {
  it("includes later shipments and receipts beyond 1,000 rows when calculating availability", async () => {
    const rows = Array.from({ length: 1049 }, () => ({ product_id: "other", bucket: "ON_FLOOR", delta: 0, source_type: "FULFILLMENT" }));
    rows[0] = { product_id: "lift", bucket: "ON_FLOOR", delta: 4, source_type: "RECOUNT" };
    rows[1006] = { product_id: "lift", bucket: "ON_FLOOR", delta: -1, source_type: "FULFILLMENT" };
    rows[1048] = { product_id: "incoming-lift", bucket: "ON_FLOOR", delta: 12, source_type: "CONTAINER_RECEIVED" };
    const db = database(rows);
    const history = await loadInventoryStockHistory(db.client);
    const total = (id: string) => history.filter(row => row.product_id === id).reduce((sum, row) => sum + Number(row.delta), 0);
    expect(history).toHaveLength(1049);
    expect(total("lift")).toBe(3);
    expect(Math.max(0, total("lift") - 3)).toBe(0);
    expect(total("incoming-lift")).toBe(12);
    expect(db.query.order).toHaveBeenCalledWith("id");
    expect(db.query.range.mock.calls.some(([from]) => from >= 1000)).toBe(true);
    expect(db.query.range.mock.calls).toEqual([[0, 999], [1000, 1999]]);
  });
  it("rejects a failed later page instead of displaying a partial stock balance", async () => {
    const rows = Array.from({ length: 1100 }, () => ({ product_id: "lift", bucket: "ON_FLOOR", delta: 1, source_type: "RECOUNT" }));
    await expect(loadInventoryStockHistory(database(rows, 1000).client)).rejects.toThrow("Stock history unavailable");
  });
});
