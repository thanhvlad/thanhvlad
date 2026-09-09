import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "~/lib/rate-limit.server";

describe("rateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit and then refuses", () => {
    const options = { limit: 3, windowMs: 60_000 };
    expect(rateLimit("shop1", options).allowed).toBe(true);
    expect(rateLimit("shop1", options).allowed).toBe(true);
    expect(rateLimit("shop1", options).allowed).toBe(true);

    const refused = rateLimit("shop1", options);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);
  });

  it("keeps one caller's budget away from another's", () => {
    const options = { limit: 1, windowMs: 60_000 };
    expect(rateLimit("shop1", options).allowed).toBe(true);
    expect(rateLimit("shop1", options).allowed).toBe(false);
    // A different shop is unaffected: the limiter protects each merchant's own
    // supplier quota, it is not a global gate.
    expect(rateLimit("shop2", options).allowed).toBe(true);
  });

  it("refills over time", async () => {
    const options = { limit: 2, windowMs: 100 };
    expect(rateLimit("shop1", options).allowed).toBe(true);
    expect(rateLimit("shop1", options).allowed).toBe(true);
    expect(rateLimit("shop1", options).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(rateLimit("shop1", options).allowed).toBe(true);
  });
});
