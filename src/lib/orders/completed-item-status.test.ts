import { expect, it } from "vitest";
import { completedItemStatus } from "./completed-item-status";

it("distinguishes zero-quantity service rows, shipped physical items and open obligations", () => {
  expect(completedItemStatus(0, 0, false)).toBe("N/A");
  expect(completedItemStatus(1, 0, false)).toBe("Shipped");
  expect(completedItemStatus(1, 1, false)).toBeNull();
  expect(completedItemStatus(1, 1, true)).toBe("N/A");
});
