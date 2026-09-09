import { Badge } from "@shopify/polaris";
import type { I18nKey } from "~/lib/i18n";
import { useT } from "~/lib/use-t";

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
  IGNORED: undefined,
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

/**
 * Order pipeline stages live under `stage.*`; everything else (purchase orders,
 * imports, jobs) under `status.*`. Both fall back to the raw value, so a status
 * we have not seen still renders.
 */
const STAGE_KEYS = new Set([
  "PENDING", "AWAITING_ORDER", "AWAITING_PAYMENT", "AWAITING_SHIPMENT",
  "AWAITING_DELIVERY", "FULFILLED", "CANCELED", "FAILED", "IGNORED",
]);

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  const t = useT();
  if (!status) return null;
  const key = status.toUpperCase();
  const translated = STAGE_KEYS.has(key)
    ? t(`stage.${key}` as I18nKey)
    : t(`status.${key}` as I18nKey);
  return (
    <Badge tone={STAGE_TONES[key]} progress={key === "RUNNING" || key === "PUSHING" || key === "SUBMITTING" ? "partiallyComplete" : undefined}>
      {label ?? translated ?? status}
    </Badge>
  );
}

export function PlatformBadge({ platform }: { platform: string }) {
  const label = platform === "ALIEXPRESS" ? "AliExpress" : platform === "CJ_DROPSHIPPING" ? "CJ" : platform === "MOCK" ? "Mock" : platform;
  return <Badge tone={platform === "MOCK" ? "new" : "info"}>{label}</Badge>;
}
