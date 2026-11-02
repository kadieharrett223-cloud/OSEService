import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { containerInventoryOptions, matchingContainerProducts, productLookupText, validateContainerProductRows } from "./product-selection";

const catalog = [
  { id: "lift", sku: "4PXW-10", name: "Lift", status: "Active" },
  { id: "scal", sku: "SCAL-9", name: "SCAL-9", status: "Active" },
  { id: "retired", sku: "BAD", name: "Retired", status: "Inactive" },
];
function form(rows: Array<[string, string]>) {
  const data = new FormData();
  for (const [id, qty] of rows) { data.append("product_id", id); data.append("product_qty", qty); }
  return data;
}
describe("container catalog selection", () => {
  it("offers one real inventory identity, with readable codes, excluding legacy and accounting copies", () => {
    const products = [
      { id: "lift", sku: "4PXL-10", canonical_name: "Model: Olympic 4PXL-10 / SHIPS FREE!", status: "Active" },
      { id: "legacy", sku: "000173", canonical_name: "Model: Olympic 4PXL-10 / old copy", status: "Active" },
      { id: "b", sku: "000014", canonical_name: "4PXL-10B", status: "Active" },
      { id: "tray", sku: "000097", canonical_name: "4PDT Drip Trays for 4PXL-10", status: "Active" },
      { id: "freight", sku: "SHIPPING", canonical_name: "Shipping charge", status: "Active" },
      { id: "test", sku: "TEST", canonical_name: "Test product", status: "Active" },
      { id: "inactive", sku: "OLD", canonical_name: "Old lift", status: "Inactive" },
    ];
    const routes = products.map(p => ({ product_id: p.id, stock_product_id: p.id === "legacy" ? "lift" : p.id, operational_key: p.id === "tray" ? "4PDT45" : p.id === "b" ? "4PXL10B" : p.id === "lift" || p.id === "legacy" ? "4PXL10" : p.sku }));
    const options = containerInventoryOptions(products, routes);
    expect(options.map(p => p.id)).toEqual(["tray", "lift", "b"]);
    expect(matchingContainerProducts(options, "4pxl_10").map(p => p.id)).toEqual(["lift"]);
    expect(matchingContainerProducts(options, "drip").map(p => p.id)).toEqual(["tray"]);
    expect(matchingContainerProducts(options, "no such product")).toEqual([]);
    expect(() => validateContainerProductRows(form([["legacy", "1"]]), options)).toThrow();
    expect(validateContainerProductRows(form([["lift", "2"]]), options)).toEqual([{ productId: "lift", qty: 2 }]);
  });
  it("does not guess an inventory identity without an authoritative route", () => {
    expect(containerInventoryOptions([{ id: "x", sku: "LIFT", canonical_name: "Lift", status: "Active" }], [])).toEqual([]);
  });
  it("uses a component's identity instead of the compatible lift at the start of its name", () => {
    const options = containerInventoryOptions([{ id: "cylinder", sku: "000111", canonical_name: "4PHDXLA-14 Cylinder", status: "Active" }], [{ product_id: "cylinder", stock_product_id: "cylinder", operational_key: "HCHD14" }]);
    expect(options[0].sku).toBe("HCHD14");
  });
  it("keeps readable model codes when a legacy routing key contains the full title", () => {
    const options = containerInventoryOptions([{ id: "stacker", sku: "100000008", canonical_name: "4032-4 Four Stacker", status: "Active" }], [{ product_id: "stacker", stock_product_id: "stacker", operational_key: "4032440324THEFOURSTACKERFOURLEVELCARSTORAGELIFT" }]);
    expect(options[0].sku).toBe("4032-4");
  });
  it("deduplicates legacy self-owned ledgers by reviewed identity without changing them", () => {
    const products = [
      { id: "old", sku: "000013", canonical_name: "HK-4PC-6", status: "Active" },
      { id: "current", sku: "000235", canonical_name: "4PC-6", status: "Active" },
      { id: "natural", sku: "4PC-6", canonical_name: "Little Buddy", status: "Active" },
    ];
    const routes = [
      { product_id: "old", stock_product_id: "old", operational_key: "4PC6" },
      { product_id: "current", stock_product_id: "current", operational_key: "4PC6" },
      { product_id: "natural", stock_product_id: "current", operational_key: "4PC6" },
    ];
    expect(containerInventoryOptions(products, routes)).toEqual([{ id: "current", sku: "4PC-6", name: "4PC-6" }]);
    expect(containerInventoryOptions([...products].reverse(), [...routes].reverse())).toEqual(containerInventoryOptions(products, routes));
    expect(routes[0].stock_product_id).toBe("old");
  });
  it("normalizes underscore searches without inventing products", () => {
    expect(productLookupText("4pxw_10")).toBe("4PXW-10");
  });
  it("retains selected identities and quantities", () => {
    expect(validateContainerProductRows(form([["lift", "8"], ["scal", "3"]]), catalog))
      .toEqual([{productId:"lift",qty:8},{productId:"scal",qty:3}]);
  });
  it("merges repeated selections without dropping quantities", () => {
    expect(validateContainerProductRows(form([["lift","2"],["lift","6"]]),catalog)).toEqual([{productId:"lift",qty:8}]);
  });
  it.each([["4PXW_10","8"],["retired","1"],["","3"],["lift","0"],["lift","Infinity"],["lift","1.5"],["lift",""]])("rejects invalid identity/quantity %s %s", (id,qty) => {
    expect(()=>validateContainerProductRows(form([[id,qty]]),catalog)).toThrow();
  });
  it("allows a genuinely blank optional row", () => {
    expect(validateContainerProductRows(form([["",""]]),catalog)).toEqual([]);
  });
  it("rejects old free-text forms rather than creating typo SKUs", () => {
    const data = new FormData();data.append("product_sku","4PXW_10");data.append("product_qty","8");
    expect(()=>validateContainerProductRows(data,catalog)).toThrow(/lookup/);
  });
  it("validates before saving, never creates catalog products, and invalidates shared inventory reads", () => {
    const source=readFileSync("src/app/(protected)/containers/actions.ts","utf8").split("type ReceiptEntry")[0];
    expect(source.indexOf("validateContainerProductRows(formData")).toBeLessThan(source.indexOf('.from("containers")'));
    expect(source).not.toContain("createdProduct");
    expect(source).toContain("revalidateOrdersProjection()");
    expect(source).toContain('revalidatePath("/inventory")');
    expect(source).not.toContain('from("inventory_transactions")');
  });
});
