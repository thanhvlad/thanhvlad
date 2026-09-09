import type { AddressIssue } from "./address";
import type { ResolveResult } from "../mapping/types";

export type OrderStage =
  | "PENDING"
  | "AWAITING_ORDER"
  | "AWAITING_PAYMENT"
  | "AWAITING_SHIPMENT"
  | "AWAITING_DELIVERY"
  | "FULFILLED"
  | "CANCELED"
  | "FAILED"
  | "IGNORED";

export type PurchaseOrderStatus =
  | "DRAFT"
  | "SUBMITTING"
  | "PLACED"
  | "AWAITING_PAYMENT"
  | "PAID"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELED"
  | "FAILED";

export interface OrderIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  lineItemId?: string;
  field?: string;
}

export interface PipelineLineItem {
  id: string;
  title: string;
  quantity: number;
  fulfillableQuantity: number;
  isCanceled: boolean;
  isFulfilled: boolean;
  /** Result of resolveMapping() for this line, if it was run. */
  resolution?: ResolveResult | null;
  /** Line items whose product is not managed by the app are ignored. */
  isManaged: boolean;
}

export interface PipelineInput {
  financialStatus: string | null | undefined;
  fulfillmentStatus: string | null | undefined;
  canceledAt?: Date | string | null;
  lineItems: PipelineLineItem[];
  addressIssues: AddressIssue[];
  purchaseOrders: Array<{ status: PurchaseOrderStatus; hasTracking: boolean }>;
  /**
   * Ids of line items that a live purchase order already covers.
   *
   * Without it the evaluator cannot tell a partly-ordered order from a fully
   * ordered one and would report supplier progress for the whole order as soon
   * as any purchase order exists, stranding the lines nobody ordered. Callers
   * that read purchase orders should always pass it; when it is omitted every
   * outstanding line is assumed covered.
   */
  coveredLineItemIds?: string[];
  settings: {
    /** Only place supplier orders once Shopify says the order is paid. */
    requirePaidOrder: boolean;
    /** Refuse to order when Shopify flags the order as high risk. */
    blockHighRisk: boolean;
    /** Refuse to order when the customer used a partial payment. */
    blockPartiallyPaid: boolean;
  };
  riskLevel?: string | null;
}

export interface PipelineResult {
  stage: OrderStage;
  issues: OrderIssue[];
  /** True when the order can be pushed to a supplier right now. */
  canPlaceOrder: boolean;
  /** Line items that still need attention before the order can be placed. */
  blockedLineItemIds: string[];
}

const TERMINAL_PO: PurchaseOrderStatus[] = ["DELIVERED", "SHIPPED"];

/**
 * A failed supplier order must be reported, but it does not stop a *different*
 * line item from being ordered, so it is excluded from the placement gate.
 */
export function blocksPlacement(issue: OrderIssue): boolean {
  return issue.severity === "error" && issue.code !== "SUPPLIER_ORDER_FAILED";
}

/**
 * Derive the internal pipeline stage and the list of blocking problems for one
 * Shopify order. Pure: everything it needs is passed in, so the orders list,
 * the order detail page and the bulk "place orders" job all agree on state.
 */
export function evaluateOrder(input: PipelineInput): PipelineResult {
  const issues: OrderIssue[] = [];
  const blocked = new Set<string>();

  if (input.canceledAt) {
    return { stage: "CANCELED", issues, canPlaceOrder: false, blockedLineItemIds: [] };
  }

  const managed = input.lineItems.filter((li) => li.isManaged && !li.isCanceled);
  const outstanding = managed.filter((li) => !li.isFulfilled && li.fulfillableQuantity > 0);
  const pos = input.purchaseOrders;

  // Nothing on this order is ours. Its own terminal stage, so it does not sit in
  // Pending forever with no action attached to it.
  if (managed.length === 0) {
    issues.push({
      code: "NO_MANAGED_ITEMS",
      severity: "warning",
      message: "No line item on this order is managed by the app.",
    });
    return { stage: "IGNORED", issues, canPlaceOrder: false, blockedLineItemIds: [] };
  }

  // ---- Supplier-side progress ----------------------------------------------
  const covered = input.coveredLineItemIds ? new Set(input.coveredLineItemIds) : null;
  // Without coverage information every outstanding line is assumed covered,
  // which is the historical behaviour.
  const needsOrdering = covered ? outstanding.filter((li) => !covered.has(li.id)) : outstanding;
  const uncovered = covered ? needsOrdering : [];

  const failedCount = pos.filter((po) => po.status === "FAILED").length;
  if (failedCount > 0) {
    // Reported whatever else happened: a failure hidden behind a sibling
    // purchase order that shipped is a failure the merchant never fixes.
    issues.push({
      code: "SUPPLIER_ORDER_FAILED",
      severity: "error",
      message: `${failedCount} supplier order(s) failed. Review the error and retry.`,
    });
  }

  if (pos.length > 0) {
    const live = pos.filter((po) => po.status !== "CANCELED" && po.status !== "FAILED");
    const anyShipped = live.some(
      (po) => po.status === "SHIPPED" || po.status === "DELIVERED" || po.hasTracking,
    );
    const anyPaid = live.some((po) => po.status === "PAID");
    const anyAwaitingPayment = live.some(
      (po) => po.status === "PLACED" || po.status === "AWAITING_PAYMENT",
    );
    const anyLive = anyShipped || anyPaid || anyAwaitingPayment;

    if (!anyLive) {
      if (failedCount > 0) {
        return { stage: "FAILED", issues, canPlaceOrder: false, blockedLineItemIds: [] };
      }
    } else if (uncovered.length === 0) {
      // The whole order is in flight upstream. Supplier progress decides the
      // stage even once Shopify's line items are fulfilled: the app creates the
      // fulfilment the moment tracking arrives, so an order whose parcel is
      // still in transit would otherwise read as delivered.
      const allDelivered = live.every((po) => po.status === "DELIVERED");
      const allTerminal = live.every((po) => TERMINAL_PO.includes(po.status));
      if (allDelivered || (allTerminal && input.fulfillmentStatus === "fulfilled" && outstanding.length === 0)) {
        return { stage: "FULFILLED", issues, canPlaceOrder: false, blockedLineItemIds: [] };
      }
      if (anyShipped) {
        return { stage: "AWAITING_DELIVERY", issues, canPlaceOrder: false, blockedLineItemIds: [] };
      }
      if (anyPaid) {
        return { stage: "AWAITING_SHIPMENT", issues, canPlaceOrder: false, blockedLineItemIds: [] };
      }
      return { stage: "AWAITING_PAYMENT", issues, canPlaceOrder: false, blockedLineItemIds: [] };
    } else {
      // Part of the order is upstream and part of it was never sent. Say so and
      // fall through, so the remaining lines can still be placed.
      issues.push({
        code: "LINES_NOT_ORDERED",
        severity: "warning",
        message: `${uncovered.length} line item(s) on this order have not been sent to a supplier yet.`,
      });
    }
  }

  // Every managed line is done and no supplier order is still in flight.
  // Shopify's own fulfillmentStatus can sit at "partial" indefinitely because of
  // an unmanaged line (a gift card, a service, a locally stocked item), so it is
  // not the signal we key on.
  if (outstanding.length === 0) {
    return { stage: "FULFILLED", issues, canPlaceOrder: false, blockedLineItemIds: [] };
  }

  // ---- Local readiness checks ----------------------------------------------
  for (const issue of input.addressIssues) {
    issues.push({
      code: `ADDRESS_${issue.code}`,
      severity: issue.severity,
      message: issue.message,
      field: String(issue.field),
    });
  }

  const financial = (input.financialStatus ?? "").toLowerCase();
  if (input.settings.requirePaidOrder && financial !== "paid") {
    if (financial === "partially_paid" && !input.settings.blockPartiallyPaid) {
      issues.push({
        code: "PARTIALLY_PAID",
        severity: "warning",
        message: "The order is only partially paid.",
      });
    } else {
      issues.push({
        code: "NOT_PAID",
        severity: "error",
        message: `The order is "${financial || "unpaid"}"; supplier orders are held until it is paid.`,
      });
    }
  }

  if (input.settings.blockHighRisk && (input.riskLevel ?? "").toUpperCase() === "HIGH") {
    issues.push({
      code: "HIGH_RISK",
      severity: "error",
      message: "Shopify flagged this order as high risk.",
    });
  }

  // Only the lines still to be ordered need a resolvable supplier; a line
  // already covered by a live purchase order is settled whatever its mapping
  // looks like today.
  for (const line of needsOrdering) {
    const resolution = line.resolution;
    if (!resolution) {
      blocked.add(line.id);
      issues.push({
        code: "MAPPING_NOT_RESOLVED",
        severity: "error",
        message: `"${line.title}" has not been matched to a supplier yet.`,
        lineItemId: line.id,
      });
      continue;
    }
    if (!resolution.ok) {
      blocked.add(line.id);
      issues.push({
        code: resolution.failure ?? "MAPPING_FAILED",
        severity: "error",
        message: `"${line.title}": ${resolution.reason ?? "supplier could not be resolved."}`,
        lineItemId: line.id,
      });
    }
  }

  const canPlaceOrder = !issues.some(blocksPlacement) && needsOrdering.length > 0;

  return {
    stage: canPlaceOrder ? "AWAITING_ORDER" : failedCount > 0 ? "FAILED" : "PENDING",
    issues,
    canPlaceOrder,
    blockedLineItemIds: [...blocked],
  };
}

/** Map a supplier purchase-order status onto the order's pipeline stage. */
export function stageForPurchaseOrder(status: PurchaseOrderStatus): OrderStage {
  switch (status) {
    case "DRAFT":
    case "SUBMITTING":
      return "AWAITING_ORDER";
    case "PLACED":
    case "AWAITING_PAYMENT":
      return "AWAITING_PAYMENT";
    case "PAID":
      return "AWAITING_SHIPMENT";
    case "SHIPPED":
      return "AWAITING_DELIVERY";
    case "DELIVERED":
      return "FULFILLED";
    case "CANCELED":
      return "CANCELED";
    case "FAILED":
      return "FAILED";
    default:
      return "PENDING";
  }
}

export const STAGE_LABELS: Record<OrderStage, string> = {
  PENDING: "Pending",
  AWAITING_ORDER: "Awaiting order",
  AWAITING_PAYMENT: "Awaiting payment",
  AWAITING_SHIPMENT: "Awaiting shipment",
  AWAITING_DELIVERY: "Awaiting delivery",
  FULFILLED: "Fulfilled",
  CANCELED: "Canceled",
  FAILED: "Failed",
  IGNORED: "Not ours",
};

/** Tab order for the Orders page. */
export const STAGE_ORDER: OrderStage[] = [
  "PENDING",
  "AWAITING_ORDER",
  "AWAITING_PAYMENT",
  "AWAITING_SHIPMENT",
  "AWAITING_DELIVERY",
  "FULFILLED",
  "CANCELED",
  "FAILED",
  "IGNORED",
];
