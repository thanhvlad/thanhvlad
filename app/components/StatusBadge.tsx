import { Badge } from "@shopify/polaris";

type Tone = "info" | "success" | "warning" | "critical" | "attention" | "new" | undefined;

const STAGE_TONES: Record<string, Tone> = {
  PENDING: "attention",
  AWAITING_ORDER: "info",
  AWAITING_PAYMENT: "warning",
  AWAITING_SHIPMENT: "info",
  AWAITING_DELIVERY: "info",
  FULFILLED: "success",
  CANCELED: undefined,
  FAILED: "critical",
  // Purchase orders
  DRAFT: undefined,
  SUBMITTING: "info",
  PLACED: "info",
  PAID: "info",
  SHIPPED: "success",
  DELIVERED: "success",
  // Imports
  READY: "info",
  PUSHING: "info",
  PUSHED: "success",
  ARCHIVED: undefined,
  // Jobs
  QUEUED: "attention",
  RUNNING: "info",
  SUCCEEDED: "success",
  // Generic
  ACTIVE: "success",
  ENABLED: "success",
  DISABLED: undefined,
};

const LABELS: Record<string, string> = {
  PENDING: "Pending",
  AWAITING_ORDER: "Awaiting order",
  AWAITING_PAYMENT: "Awaiting payment",
  AWAITING_SHIPMENT: "Awaiting shipment",
  AWAITING_DELIVERY: "Awaiting delivery",
  FULFILLED: "Fulfilled",
  CANCELED: "Canceled",
  FAILED: "Failed",
  DRAFT: "Draft",
  SUBMITTING: "Submitting",
  PLACED: "Placed",
  PAID: "Paid",
  SHIPPED: "Shipped",
  DELIVERED: "Delivered",
  READY: "Ready",
  PUSHING: "Pushing",
  PUSHED: "Pushed",
  ARCHIVED: "Archived",
  QUEUED: "Queued",
  RUNNING: "Running",
  SUCCEEDED: "Succeeded",
  ACTIVE: "Active",
};

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  if (!status) return null;
  const key = status.toUpperCase();
  return (
    <Badge tone={STAGE_TONES[key]} progress={key === "RUNNING" || key === "PUSHING" || key === "SUBMITTING" ? "partiallyComplete" : undefined}>
      {label ?? LABELS[key] ?? status}
    </Badge>
  );
}

export function PlatformBadge({ platform }: { platform: string }) {
  const label = platform === "ALIEXPRESS" ? "AliExpress" : platform === "CJ_DROPSHIPPING" ? "CJ" : platform === "MOCK" ? "Mock" : platform;
  return <Badge tone={platform === "MOCK" ? "new" : "info"}>{label}</Badge>;
}
