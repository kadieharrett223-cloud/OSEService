import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { productLookupText, validateContainerProductRows } from "./product-selection";

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
