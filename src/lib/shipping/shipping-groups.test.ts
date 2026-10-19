import { describe, expect, it } from "vitest";
import {
  ageDays,
  groupShippingCandidates,
  invoiceDeliveryAddress,
  zipMiles,
  type ShippingCandidate,
} from "./shipping-groups";
import { readFileSync } from "node:fs";
const now = new Date("2026-10-19T19:00:00Z");
const address = {
  Line1: "100 Main Street",
  City: "Vancouver",
  CountrySubDivisionCode: "WA",
  PostalCode: "98660-1234",
};
const candidate = (
  id: string,
  point: [number, number],
  state = "WA",
): ShippingCandidate => ({
  orderId: id,
  invoice: id,
  customer: id,
  priorityDate: "2026-10-18",
  orderDate: "2026-10-18",
  address: {
    street: "100 Main",
    city: "City",
    state,
    zip: "98660",
    country: "US",
  },
  addressIssue: null,
  point,
  lifts: [
    {
      sku: "4PC-6",
      quantity: 1,
      packageLabel: "Unknown",
      unitWeight: null,
      queuePosition: "1",
    },
  ],
  instructions: "",
});
describe("invoice delivery address", () => {
  it("parses one complete free-text QBO destination but flags conflicting address lines", () => {
    expect(
      invoiceDeliveryAddress({
        Line1: "Name",
        Line2: "506 S Cliff Ave",
        Line3: "Sioux Falls, SD  57103",
      }).address,
    ).toMatchObject({ city: "Sioux Falls", state: "SD", zip: "57103" });
    expect(
      invoiceDeliveryAddress({
        Line1: "100 Main",
        Line2: "Seattle, WA 98101",
        Line3: "Portland, OR 97201",
      }).address,
    ).toBeNull();
    expect(
      invoiceDeliveryAddress({ Line1: "See Notes", Line2: "Seattle, WA 98101" })
        .address,
    ).toBeNull();
    expect(
      invoiceDeliveryAddress({
        Line1: "100 Main",
        Line2: "Harvey, ND 58341 701-693-5259",
      }).address,
    ).toBeNull();
  });
  it("reads invoice ship-to and preserves ZIP leading zeros and ZIP+4 normalization", () => {
    expect(
      invoiceDeliveryAddress({
        ...address,
        PostalCode: "02108-1234",
        CountrySubDivisionCode: "MA",
      }).address?.zip,
    ).toBe("02108");
  });
  it.each([
    null,
    {},
    { BillAddr: address },
    { ShipAddr: address },
    { ...address, City: "" },
  ])(
    "flags missing data without using billing/customer defaults: %j",
    (raw) => {
      expect(invoiceDeliveryAddress(raw).address).toBeNull();
    },
  );
  it("rejects PO boxes and non-US destinations rather than geocoding guesses", () => {
    expect(
      invoiceDeliveryAddress({ ...address, Line1: "P.O. Box 25" }).issue,
    ).toContain("PO Box");
    expect(
      invoiceDeliveryAddress({ ...address, Country: "Canada" }).address,
    ).toBeNull();
  });
});
describe("read-only quote grouping", () => {
  it("allows nearby customers across state lines without interpreting ZIP digits as distance", () => {
    const result = groupShippingCandidates(
      [
        candidate("WA", [45.63, -122.67]),
        candidate("OR", [45.52, -122.68], "OR"),
      ],
      120,
      7,
      now,
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].orders).toHaveLength(2);
    expect(zipMiles([45.63, -122.67], [45.52, -122.68])).toBeLessThan(10);
  });
  it("checks every pair, not a chain of destinations that exceeds the maximum diameter", () => {
    const result = groupShippingCandidates(
      [candidate("a", [0, 0]), candidate("b", [0, 1]), candidate("c", [0, 2])],
      80,
      7,
      now,
    );
    expect(result.groups.map((g) => g.orders.length)).toEqual([2, 1]);
    expect(result.groups.every((g) => g.maxMiles <= 80)).toBe(true);
  });
  it("does not hide missing destinations or reassign their existing stock coverage", () => {
    const missing = {
      ...candidate("missing", [0, 0]),
      address: null,
      point: null,
    };
    const before = JSON.stringify(missing);
    const result = groupShippingCandidates([missing], 120, 7, now);
    expect(result.review).toEqual([missing]);
    expect(result.groups).toEqual([]);
    expect(JSON.stringify(missing)).toBe(before);
  });
  it("keeps age/date priority and flags ASAP/maximum waiting without inventing a ship date", () => {
    const newer = candidate("new", [45.52, -122.68]);
    const older = {
      ...candidate("old", [45.53, -122.67]),
      orderDate: "2026-10-01",
      priorityDate: "2026-10-01",
      instructions: "ASAP, forklift onsite",
    };
    const result = groupShippingCandidates([newer, older], 120, 7, now);
    expect(result.groups[0].orders[0].orderId).toBe("old");
    expect(result.groups[0].doNotDelay).toBe(true);
    expect(ageDays(null, now)).toBeNull();
  });
  it("never exposes write/fulfillment/sync actions from the new recommendation loader", () => {
    const loader = readFileSync(
      "src/lib/shipping/shipping-groups-loader.ts",
      "utf8",
    );
    expect(loader).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
    expect(loader).toContain("resolveProductCoverage");
    expect(loader).toContain("authoritativeStockProductIds");
    expect(loader).toContain("validateProductCoverage");
  });
  it("address migration writes only shipping-order delivery metadata, never stock or fulfillment", () => {
    const sql = readFileSync(
      "supabase/migrations/20261019192648_shipping_group_delivery_metadata.sql",
      "utf8",
    );
    expect(sql).not.toMatch(
      /(?:insert into|update|delete from)\s+(?:public\.)?(inventory_transactions|inventory_allocations|fulfillments|shipping_order_lines|order_shipments)/i,
    );
    expect(sql.replace(/^--.*$/gm, "")).not.toContain("BillAddr");
  });
});
