import { describe, expect, it } from "vitest";
import {
  cancellationAwareOperationalTotals,
  cancellationAwareStatus,
  isCancelledOrder,
} from "./cancellation-presentation";

describe("cancelled order presentation", () => {
  it("makes cancellation override payment, stock, and readiness-derived labels", () => {
    expect(isCancelledOrder("cancelled")).toBe(true);
    expect(cancellationAwareStatus(true, "Ready to Ship")).toBe("Cancelled");
    expect(cancellationAwareStatus(true, "Paid")).toBe("Cancelled");
  });

  it("closes remaining operational demand while preserving ordered and shipped history", () => {
    expect(cancellationAwareOperationalTotals({ ordered: 3, fulfilled: 1, remaining: 2 }, true)).toEqual({
      ordered: 3,
      fulfilled: 1,
      remaining: 0,
    });
  });

  it("does not alter an active order", () => {
    expect(cancellationAwareOperationalTotals({ ordered: 3, fulfilled: 1, remaining: 2 }, false)).toEqual({
      ordered: 3,
      fulfilled: 1,
      remaining: 2,
    });
    expect(cancellationAwareStatus(false, "Ready to Ship")).toBe("Ready to Ship");
  });
});
