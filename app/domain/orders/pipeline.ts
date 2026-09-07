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
  | "FAILED";

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

  // ---- Supplier-side progress wins over local readiness ---------------------
  const pos = input.purchaseOrders;
  if (pos.length > 0) {
    const allTerminal = pos.every((po) => TERMINAL_PO.includes(po.status));
    const anyFailed = pos.some((po) => po.status === "FAILED");
    const anyShipped = pos.some((po) => po.status === "SHIPPED" || po.hasTracking);
    const anyPaid = pos.some((po) => po.status === "PAID");
    const anyAwaitingPayment = pos.some(
      (po) => po.status === "PLACED" || po.status === "AWAITING_PAYMENT",
    );

    if (anyFailed && !anyShipped) {
      issues.push({
        code: "SUPPLIER_ORDER_FAILED",
        severity: "error",
        message: `${pos.filter((p) => p.status === "FAILED").length} supplier order(s) failed. Review the error and retry.`,
      });
      return { stage: "FAILED", issues, canPlaceOrder: false, blockedLineItemIds: [] };
    }
    if (allTerminal && input.fulfillmentStatus === "fulfilled") {
      return { stage: "FULFILLED", issues, canPlaceOrder: false, blockedLineItemIds: [] };
    }
    if (anyShipped) {
      return { stage: "AWAITING_DELIVERY", issues, canPlaceOrder: false, blockedLineItemIds: [] };
    }
    if (anyPaid) {
      return { stage: "AWAITING_SHIPMENT", issues, canPlaceOrder: false, blockedLineItemIds: [] };
    }
    if (anyAwaitingPayment) {
      return { stage: "AWAITING_PAYMENT", issues, canPlaceOrder: false, blockedLineItemIds: [] };
    }
  }

  if (input.fulfillmentStatus === "fulfilled" && outstanding.length === 0) {
    return { stage: "FULFILLED", issues, canPlaceOrder: false, blockedLineItemIds: [] };
  }

  // ---- Local readiness checks ----------------------------------------------
  if (managed.length === 0) {
    issues.push({
      code: "NO_MANAGED_ITEMS",
      severity: "warning",
      message: "No line item on this order is managed by the app.",
    });
  }

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

  for (const line of outstanding) {
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

  const hasBlockingIssue = issues.some((i) => i.severity === "error");
  const canPlaceOrder = !hasBlockingIssue && outstanding.length > 0;

  return {
    stage: canPlaceOrder ? "AWAITING_ORDER" : "PENDING",
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
];
