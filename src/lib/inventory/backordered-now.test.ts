import { describe, expect, it } from "vitest";
import { getAfterIncomingInventory } from "./after-incoming";
import { getBackorderedNow } from "./backordered-now";

describe("backordered-now display", () => {
  it("shows the current shortage even when incoming stock covers it later", () => {
    const inventory = { onFloor: 3, openDemand: 4, incoming: 10 };
    expect(getBackorderedNow(inventory)).toBe(1);
    expect(getAfterIncomingInventory(inventory)).toEqual({
      availableAfterIncoming: 9,
      backorderedAfterIncoming: 0,
    });
    expect(inventory).toEqual({ onFloor: 3, openDemand: 4, incoming: 10 });
  });

  it.each([
    [0, 33, 33],
    [2, 8, 6],
    [3, 3, 0],
    [6, 2, 0],
    [7, 0, 0],
    [-3, 1, 1],
    [-3, 0, 0],
  ])("floor %s and demand %s display %s backordered", (onFloor, openDemand, expected) => {
    expect(getBackorderedNow({ onFloor, openDemand })).toBe(expected);
  });
});
