import { describe, expect, it } from "vitest";
import { decodeQueueCache, encodeQueueCache } from "./queue-cache-codec";

describe("lossless queue cache", () => {
  it("keeps oversized repeated invoice data below the cache limit without dropping fields", async () => {
    const payload = { PrivateNote: "Shipment evidence", Balance: 8638.01, Line: Array.from({ length: 60 }, (_, id) => ({ id, description: "Product description".repeat(10), quantity: id % 5 })) };
    const value = { queue: Array.from({ length: 600 }, (_, id) => ({ id, qty: 2, shippedQty: 1, raw_payload: payload, sourceInvoiceId: `invoice-${id}` })) };
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(2 * 1024 * 1024);
    const encoded = await encodeQueueCache(value);
    expect(Buffer.byteLength(encoded)).toBeLessThan(2 * 1024 * 1024);
    expect(await decodeQueueCache(encoded)).toEqual(value);
  });
  it("preserves empty arrays, nulls, Unicode, negative and fractional quantities", async () => {
    const value = { lines: [], qty: -1.5, note: "× 1 — customer's lift", missing: null, active: false, entries: [["line", { position: "26–27" }]] };
    expect(await decodeQueueCache(await encodeQueueCache(value))).toEqual(value);
  });
  it("rejects corrupt cache data rather than returning an empty or partial queue", async () => {
    await expect(decodeQueueCache("invalid")).rejects.toThrow();
  });
});
