import { describe, expect, it } from "vitest";
import { evaluateOrder, type PipelineInput } from "~/domain/orders/pipeline";

const okResolution = { ok: true, lines: [], totalCost: "0.00", skipped: [] };

const base: PipelineInput = {
  financialStatus: "paid",
  fulfillmentStatus: null,
  lineItems: [
    { id: "li1", title: "Hat", quantity: 1, fulfillableQuantity: 1, isCanceled: false, isFulfilled: false, isManaged: true, resolution: okResolution },
  ],
  addressIssues: [],
  purchaseOrders: [],
  settings: { requirePaidOrder: true, blockHighRisk: true, blockPartiallyPaid: true },
};

describe("evaluateOrder", () => {
  it("is ready to order when paid, mapped and addressed", () => {
    const result = evaluateOrder(base);
    expect(result.stage).toBe("AWAITING_ORDER");
    expect(result.canPlaceOrder).toBe(true);
  });

  it("holds unpaid orders in PENDING", () => {
    const result = evaluateOrder({ ...base, financialStatus: "pending" });
    expect(result.stage).toBe("PENDING");
    expect(result.issues[0].code).toBe("NOT_PAID");
  });

  it("blocks on unresolved mappings and names the line", () => {
    const result = evaluateOrder({
      ...base,
      lineItems: [{ ...base.lineItems[0], resolution: { ok: false, lines: [], totalCost: "0", failure: "NO_MAPPING", reason: "nope", skipped: [] } }],
    });
    expect(result.stage).toBe("PENDING");
    expect(result.blockedLineItemIds).toEqual(["li1"]);
    expect(result.issues[0].code).toBe("NO_MAPPING");
  });

  it("treats address warnings as non-blocking", () => {
    const result = evaluateOrder({
      ...base,
      addressIssues: [{ code: "INVALID_ZIP", field: "zip", severity: "warning", message: "looks odd" }],
    });
    expect(result.canPlaceOrder).toBe(true);
  });

  it("follows the purchase order lifecycle", () => {
    expect(evaluateOrder({ ...base, purchaseOrders: [{ status: "PLACED", hasTracking: false }] }).stage).toBe("AWAITING_PAYMENT");
    expect(evaluateOrder({ ...base, purchaseOrders: [{ status: "PAID", hasTracking: false }] }).stage).toBe("AWAITING_SHIPMENT");
    expect(evaluateOrder({ ...base, purchaseOrders: [{ status: "SHIPPED", hasTracking: true }] }).stage).toBe("AWAITING_DELIVERY");
    expect(evaluateOrder({ ...base, fulfillmentStatus: "fulfilled", purchaseOrders: [{ status: "DELIVERED", hasTracking: true }] }).stage).toBe("FULFILLED");
    expect(evaluateOrder({ ...base, purchaseOrders: [{ status: "FAILED", hasTracking: false }] }).stage).toBe("FAILED");
  });

  it("marks canceled orders", () => {
    expect(evaluateOrder({ ...base, canceledAt: new Date() }).stage).toBe("CANCELED");
  });
});
