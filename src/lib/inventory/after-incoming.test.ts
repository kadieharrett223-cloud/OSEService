import { describe, expect, it } from "vitest";
import { getAfterIncomingInventory } from "./after-incoming";

describe("after-incoming inventory", () => {
  it("reports available supply after incoming", () => {
    expect(getAfterIncomingInventory({ onFloor: 10, incoming: 5, openDemand: 8 })).toEqual({
      availableAfterIncoming: 7,
      backorderedAfterIncoming: 0,
    });
  });

  it("reports zero when incoming and stock exactly cover demand", () => {
    expect(getAfterIncomingInventory({ onFloor: 4, incoming: 6, openDemand: 10 })).toEqual({
      availableAfterIncoming: 0,
      backorderedAfterIncoming: 0,
    });
  });

  it("derives the backordered amount when incoming and stock do not cover demand", () => {
    expect(getAfterIncomingInventory({ onFloor: 1, incoming: 2, openDemand: 8 })).toEqual({
      availableAfterIncoming: 0,
      backorderedAfterIncoming: 5,
    });
  });

  it("reports JVCJ-6 as backordered 14", () => {
    expect(getAfterIncomingInventory({ onFloor: 0, incoming: 0, openDemand: 14 })).toEqual({
      availableAfterIncoming: 0,
      backorderedAfterIncoming: 14,
    });
  });
});