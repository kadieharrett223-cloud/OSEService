import { describe, expect, it } from "vitest";
import { sortCustomerQueue } from "./customer-demand-dropdown";

describe("Customer List display order", () => {
  it("sorts rows by their canonical queue position rather than input order", () => {
    const queue = [
      { position: "3", invoice: "127042", lineId: "kc" },
      { position: "4", invoice: "127082", lineId: "rich" },
      { position: "2", invoice: "125933", lineId: "kelly" },
      { position: "1", invoice: "11725", lineId: "john" },
    ];

    expect(sortCustomerQueue(queue as Parameters<typeof sortCustomerQueue>[0]).map((item) => item.lineId))
      .toEqual(["john", "kelly", "kc", "rich"]);
  });
});