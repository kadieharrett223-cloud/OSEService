import { expect, it } from "vitest";
import { getCommittedFloor } from "./floor-demand";
it("keeps Jerry's six explicitly incoming lifts off today's floor supply", () => {
  const state = {onFloor:5,openDemand:7,floorCommitted:0,containerReserved:6};
  expect(getCommittedFloor(state)).toBe(1);
  expect(state.onFloor-getCommittedFloor(state)).toBe(4);
  expect(state.onFloor).toBe(5);
});
it("preserves normal unallocated demand and explicit floor reservations", () => {
  expect(getCommittedFloor({onFloor:5,openDemand:7,floorCommitted:0,containerReserved:0})).toBe(5);
  expect(getCommittedFloor({onFloor:5,openDemand:7,floorCommitted:2,containerReserved:6})).toBe(2);
});
it("does not invent floor supply for negative stock or excess incoming reservations", () => {
  expect(getCommittedFloor({onFloor:-3,openDemand:1,floorCommitted:0,containerReserved:0})).toBe(0);
  expect(getCommittedFloor({onFloor:5,openDemand:1,floorCommitted:0,containerReserved:6})).toBe(0);
});
