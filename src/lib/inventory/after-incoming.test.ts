import { describe, expect, it } from "vitest";
import { getAfterIncomingInventory } from "./after-incoming";

describe("after-incoming inventory", () => {
  it("keeps a positive net available after incoming", () => {
    expect(getAfterIncomingInventory({ onFloor: 10, incoming: 5, openDemand: 8 })).toEqual({
      netAfterIncoming: 7,
      availableAfterIncoming: 7,
      backorderedAfterIncoming: 0,
    });
  });

  it("reports zero when incoming and stock exactly cover demand", () => {
    expect(getAfterIncomingInventory({ onFloor: 4, incoming: 6, openDemand: 10 })).toEqual({
      netAfterIncoming: 0,
      availableAfterIncoming: 0,
      backorderedAfterIncoming: 0,
    });
  });

  it("retains a negative net while deriving the backordered amount", () => {
    expect(getAfterIncomingInventory({ onFloor: 1, incoming: 2, openDemand: 8 })).toEqual({
      netAfterIncoming: -5,
      availableAfterIncoming: 0,
      backorderedAfterIncoming: 5,
    });
  });

  it("reports JVCJ-6 as net -14 and backordered 14", () => {
    expect(getAfterIncomingInventory({ onFloor: 0, incoming: 0, openDemand: 14 })).toEqual({
      netAfterIncoming: -14,
      availableAfterIncoming: 0,
      backorderedAfterIncoming: 14,
    });
  });
});