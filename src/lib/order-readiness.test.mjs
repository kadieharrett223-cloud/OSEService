import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getReadyToShipLineIds } from "./order-readiness.ts";

describe("getReadyToShipLineIds", () => {
  it("covers the earliest queue positions from available stock before the rest of the list", () => {
    const lines = Array.from({ length: 12 }, (_, index) => ({
      id: `line-${index + 1}`,
      remaining_qty: 1,
      priority: "NORMAL",
      queue_position_start: index + 1,
      approved_at: null,
      created_at: new Date("2024-01-01T00:00:00Z").toISOString(),
      has_live_allocation: false,
    }));

    const readyIds = getReadyToShipLineIds(lines, 10);

    assert.deepEqual(readyIds, [
      "line-1",
      "line-2",
      "line-3",
      "line-4",
      "line-5",
      "line-6",
      "line-7",
      "line-8",
      "line-9",
      "line-10",
    ]);
  });
});
