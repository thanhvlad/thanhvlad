/**
 * Job catalogue. Payloads are plain JSON so they survive a queue round-trip.
 */
export interface JobPayloads {
  /** Push a batch of import-list products to Shopify. */
  "push-products": { shopId: string; importedProductIds: string[]; jobRunId: string; actor?: string };
  /** Place supplier orders for a batch of Shopify orders. */
  "place-orders": { shopId: string; orderIds: string[]; jobRunId: string; actor?: string };
  /** Pull orders from Shopify (initial sync / manual). */
  "sync-orders": { shopId: string; days: number; jobRunId: string };
  /** Poll open purchase orders upstream and pull tracking. */
  "sync-purchase-orders": { shopId: string; jobRunId?: string };
  /** Push unsynced tracking numbers to Shopify. */
  "sync-tracking": { shopId: string; purchaseOrderId?: string };
  /** Run the price/stock auto-update. */
  "inventory-sync": { shopId: string; productIds?: string[]; jobRunId?: string; actor?: string };
  /** Process a stored webhook event. */
  "process-webhook": { webhookEventId: string };
  /** Auto-place AWAITING_ORDER orders older than the configured delay. */
  "auto-place-orders": { shopId: string };
  /** Refresh FX rates for a base currency. */
  "refresh-rates": { base: string };
  /** Roll up DailyMetric for a shop. */
  "rollup-metrics": { shopId: string; days: number };
  /** Fan-out tick: enqueue the per-shop periodic jobs for every active shop. */
  "scheduler-tick": { kind: "purchase-orders" | "inventory" | "metrics" | "auto-place" | "tracking" };
}

export type JobName = keyof JobPayloads;

export interface EnqueueOptions {
  /** Delay before the job runs. */
  delayMs?: number;
  /** Collapse duplicates: two enqueues with the same key run once. */
  dedupeKey?: string;
  attempts?: number;
  priority?: number;
}
