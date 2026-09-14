import { describe, expect, it } from "vitest";
import { AWAITING_EXTENSION_PLACEMENT, evaluateOrder, stageForPurchaseOrder, waitingOnlyForExtension, type PipelineInput } from "~/domain/orders/pipeline";

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

  describe("a supplier order waiting to be placed with the Chrome extension", () => {
    const waiting = { status: "AWAITING_PLACEMENT" as const, hasTracking: false };

    it("covers its lines and reads as awaiting order with a warning, not as pending", () => {
      const result = evaluateOrder({ ...base, purchaseOrders: [waiting], coveredLineItemIds: ["li1"] });
      expect(result.stage).toBe("AWAITING_ORDER");
      expect(result.canPlaceOrder).toBe(false);
      expect(result.issues).toEqual([expect.objectContaining({ code: AWAITING_EXTENSION_PLACEMENT, severity: "warning" })]);
      // The warning describes placement the one way the app describes it
      // everywhere: the merchant places and pays, the extension records it.
      expect(result.issues[0].message).toMatch(/You place and pay for the order there/);
      expect(result.issues[0].message).not.toMatch(/extension (places|pays)/);
    });

    it("is still reported as awaiting order when a sibling supplier order has shipped", () => {
      const result = evaluateOrder({ ...base, purchaseOrders: [waiting, { status: "SHIPPED", hasTracking: true }], coveredLineItemIds: ["li1"] });
      expect(result.stage).toBe("AWAITING_ORDER");
    });

    it("leaves lines nobody ordered placeable, and says both things", () => {
      const result = evaluateOrder({
        ...base,
        lineItems: [...base.lineItems, { ...base.lineItems[0], id: "li2", title: "Scarf" }],
        purchaseOrders: [waiting],
        coveredLineItemIds: ["li1"],
      });
      expect(result.stage).toBe("AWAITING_ORDER");
      expect(result.canPlaceOrder).toBe(true);
      expect(result.issues.map((i) => i.code)).toEqual([AWAITING_EXTENSION_PLACEMENT, "LINES_NOT_ORDERED"]);
    });

    it("does not count once cancelled", () => {
      const result = evaluateOrder({ ...base, purchaseOrders: [{ status: "CANCELED", hasTracking: false }], coveredLineItemIds: [] });
      expect(result.issues.map((i) => i.code)).not.toContain(AWAITING_EXTENSION_PLACEMENT);
    });

    it("tells an order with nothing left to send from one with lines still to send", () => {
      const all = evaluateOrder({ ...base, purchaseOrders: [waiting], coveredLineItemIds: ["li1"] });
      expect(waitingOnlyForExtension({ issues: all.issues, purchaseOrderStatuses: ["AWAITING_PLACEMENT"] })).toBe(true);

      const partial = evaluateOrder({
        ...base,
        lineItems: [...base.lineItems, { ...base.lineItems[0], id: "li2", title: "Scarf" }],
        purchaseOrders: [waiting],
        coveredLineItemIds: ["li1"],
      });
      expect(waitingOnlyForExtension({ issues: partial.issues, purchaseOrderStatuses: ["AWAITING_PLACEMENT"] })).toBe(false);
      expect(waitingOnlyForExtension({ issues: [], purchaseOrderStatuses: ["AWAITING_PAYMENT"] })).toBe(false);
    });

    it("maps onto the awaiting order stage", () => {
      expect(stageForPurchaseOrder("AWAITING_PLACEMENT")).toBe("AWAITING_ORDER");
    });
  });
});
