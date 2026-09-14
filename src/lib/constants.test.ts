import { describe, expect, it } from "vitest";
import { APP_ACRONYM, APP_NAME, APP_SHORT_NAME } from "./constants";

describe("application branding", () => {
  it("uses the universal Olympic Command Center identity", () => {
    expect(APP_NAME).toBe("Olympic Command Center");
    expect(APP_SHORT_NAME).toBe(APP_NAME);
    expect(APP_ACRONYM).toBe("OCC");
  });
});
