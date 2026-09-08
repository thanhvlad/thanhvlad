/**
 * The queue's option building and dedupe keying.
 *
 * Both were silently wrong in a way no test could have caught by running a job:
 * the queue accepted the work, it just never retried it and refused to run a
 * periodic job more than once a day.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildJobOptions, dedupeJobId } from "~/services/jobs/queue.server";

describe("buildJobOptions", () => {
  it("omits every key it was not given", () => {
    // BullMQ merges these over defaultJobOptions, so a present-but-undefined
    // key overwrites the default. `attempts: 3` was being discarded this way and
    // no job in the app was ever retried.
    const opts = buildJobOptions({});
    expect(Object.keys(opts)).toEqual([]);
    expect("attempts" in opts).toBe(false);
    expect("delay" in opts).toBe(false);
    expect("priority" in opts).toBe(false);
  });

  it("passes through the values it was given", () => {
    const opts = buildJobOptions({ delayMs: 500, attempts: 7, priority: 2 });
    expect(opts).toEqual({ delay: 500, attempts: 7, priority: 2 });
  });

  it("keeps a zero delay, which is a value and not an absence", () => {
    expect(buildJobOptions({ delayMs: 0 })).toEqual({ delay: 0 });
  });
});

describe("dedupeJobId", () => {
  const WINDOW = 5 * 60_000;

  it("collapses two enqueues inside one window", () => {
    const a = dedupeJobId("sync-po-shop1", WINDOW, 1_000_000_000);
    const b = dedupeJobId("sync-po-shop1", WINDOW, 1_000_000_000 + 60_000);
    expect(a).toBe(b);
  });

  it("lets the same key run again in the next window", () => {
    // Without this a periodic job ran at most once every 24 hours, because
    // BullMQ refuses a job id it already holds and keeps completed jobs for a
    // day. Every scheduled sync silently degraded to daily.
    const a = dedupeJobId("sync-po-shop1", WINDOW, 1_000_000_000);
    const b = dedupeJobId("sync-po-shop1", WINDOW, 1_000_000_000 + WINDOW * 2);
    expect(a).not.toBe(b);
  });

  it("keeps different shops apart", () => {
    const a = dedupeJobId("sync-po-shop1", WINDOW, 1_000_000_000);
    const b = dedupeJobId("sync-po-shop2", WINDOW, 1_000_000_000);
    expect(a).not.toBe(b);
  });

  it("produces an id BullMQ accepts", () => {
    const id = dedupeJobId("webhook-gid://shopify/Order/123:topic", WINDOW, 1_000_000_000);
    expect(id).not.toContain(":");
    expect(id).not.toContain("/");
    expect(id.length).toBeLessThanOrEqual(200);
  });

  it("does not collapse two long keys that share a prefix", () => {
    const prefix = "sync-purchase-orders-for-a-very-long-shop-identifier-".repeat(5);
    const a = dedupeJobId(`${prefix}alpha`, WINDOW, 1_000_000_000);
    const b = dedupeJobId(`${prefix}beta`, WINDOW, 1_000_000_000);
    expect(a).not.toBe(b);
  });
});

/**
 * The periodic schedule without Redis.
 *
 * BullMQ owns the repeatable jobs when Redis is configured. Without it nothing
 * did, so a single-service deployment ran no periodic work at all and the only
 * symptom was tracking numbers that never reached Shopify on their own.
 */
describe("startInlineSchedules", () => {
  afterEach(async () => {
    const { stopInlineSchedules } = await import("~/services/jobs/queue.server");
    stopInlineSchedules();
    vi.useRealTimers();
  });

  it("runs the whole schedule on timers and stops cleanly", async () => {
    vi.useFakeTimers();
    const queue = await import("~/services/jobs/queue.server");
    const seen: string[] = [];
    for (const name of ["scheduler-tick", "refresh-rates", "purge-uninstalled"] as const) {
      queue.registerHandler(name, async (payload) => {
        seen.push(name === "scheduler-tick" ? `tick:${(payload as { kind: string }).kind}` : name);
      });
    }

    expect(queue.startInlineSchedules()).toBe(true);
    // Calling it twice must not double every timer.
    expect(queue.startInlineSchedules()).toBe(true);

    // A full day covers every interval, the 24-hour purge included.
    // `runAllTimers` never returns on a repeating interval, so advance a fixed
    // span instead: just past a day, so the 24-hour purge — the slowest of
    // them — has fired at least once.
    await vi.advanceTimersByTimeAsync(25 * 60 * 60_000);

    // Each kind the app schedules fired, and the two global jobs with it.
    for (const kind of ["purchase-orders", "tracking", "inventory", "auto-place", "metrics", "payments", "email-digest"]) {
      expect(seen, `missing tick for ${kind}`).toContain(`tick:${kind}`);
    }
    expect(seen).toContain("refresh-rates");
    expect(seen).toContain("purge-uninstalled");

    // Tracking is the 15-minute one and must fire far more often than the
    // hourly jobs; a schedule that collapses to one tick per key is the bug
    // the dedupe window caused before.
    const tracking = seen.filter((s) => s === "tick:tracking").length;
    const metrics = seen.filter((s) => s === "tick:metrics").length;
    expect(tracking).toBeGreaterThan(metrics);

    queue.stopInlineSchedules();
    // Jobs already handed to the inline runner still finish; count after they do.
    await vi.advanceTimersByTimeAsync(1000);
    const before = seen.length;
    await vi.advanceTimersByTimeAsync(25 * 60 * 60_000);
    expect(seen.length).toBe(before);
  });
});
