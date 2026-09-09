import { describe, expect, it } from "vitest";
import { isWorthSwitching, scoreCandidates } from "~/domain/suppliers/score";

const base = { isAvailable: true, rating: 4.5, orderCount: 1000, deliveryDays: 15, coverage: 1 };

describe("scoreCandidates", () => {
  it("ranks the cheaper landed cost above the cheaper item price", () => {
    const scored = scoreCandidates([
      { id: "cheap-item-pricey-ship", itemCost: "5.00", shippingCost: "9.00", ...base },
      { id: "dearer-item-free-ship", itemCost: "8.00", shippingCost: "0.00", ...base },
    ]);
    expect(scored[0].id).toBe("dearer-item-free-ship");
    expect(scored[0].landedCost).toBe("8.00");
    expect(scored[1].landedCost).toBe("14.00");
  });

  it("rewards speed, rating and volume when landed cost ties", () => {
    const scored = scoreCandidates([
      { id: "slow", itemCost: "10", shippingCost: "0", deliveryDays: 45, rating: 4.0, orderCount: 50, isAvailable: true },
      { id: "fast", itemCost: "10", shippingCost: "0", deliveryDays: 8, rating: 4.9, orderCount: 40000, isAvailable: true },
    ]);
    expect(scored[0].id).toBe("fast");
    expect(scored[0].breakdown.speed).toBe(1);
    expect(scored[0].breakdown.volume).toBe(1);
    expect(scored[1].breakdown.speed).toBe(0);
  });

  it("never lets an out-of-stock supplier win", () => {
    const scored = scoreCandidates([
      { id: "cheapest-but-gone", itemCost: "1", shippingCost: "0", ...base, isAvailable: false },
      { id: "available", itemCost: "20", shippingCost: "5", ...base },
    ]);
    expect(scored[0].id).toBe("available");
    expect(scored.find((s) => s.id === "cheapest-but-gone")!.score).toBe(0);
  });

  it("computes savings against the current supplier", () => {
    const scored = scoreCandidates([
      { id: "current", itemCost: "12.00", shippingCost: "3.00", ...base, isCurrent: true },
      { id: "alt", itemCost: "9.00", shippingCost: "2.00", ...base },
    ]);
    const alt = scored.find((s) => s.id === "alt")!;
    expect(alt.savingsVsCurrent).toBe("4.00");
    expect(alt.savingsPercent).toBeCloseTo(26.7, 1);
    expect(scored.find((s) => s.id === "current")!.savingsVsCurrent).toBeNull();
  });

  it("penalises a supplier that covers only some variants", () => {
    const scored = scoreCandidates([
      { id: "full", itemCost: "10", shippingCost: "0", ...base, coverage: 1 },
      { id: "partial", itemCost: "9", shippingCost: "0", ...base, coverage: 0.3 },
    ]);
    expect(scored[0].id).toBe("full");
    // Coverage scales the whole score, so a third of the variants is ~a third
    // of the score even though this supplier is cheaper on every other axis.
    const partial = scored.find((s) => s.id === "partial")!;
    expect(partial.score).toBeLessThan(scored[0].score);
    expect(partial.score / 100).toBeCloseTo(0.3, 1);
  });

  it("handles a single candidate and missing data without NaN", () => {
    const scored = scoreCandidates([
      { id: "only", itemCost: "7", shippingCost: "1", deliveryDays: null, rating: null, orderCount: null, isAvailable: true },
    ]);
    expect(scored).toHaveLength(1);
    expect(Number.isFinite(scored[0].score)).toBe(true);
    expect(scored[0].isBest).toBe(true);
    expect(scored[0].landedCost).toBe("8.00");
  });

  it("returns an empty list for no candidates", () => {
    expect(scoreCandidates([])).toEqual([]);
  });

  it("respects custom weights", () => {
    const costOnly = { cost: 1, speed: 0, rating: 0, volume: 0 };
    const scored = scoreCandidates(
      [
        { id: "cheap-slow", itemCost: "5", shippingCost: "0", deliveryDays: 60, rating: 3, orderCount: 10, isAvailable: true },
        { id: "dear-fast", itemCost: "20", shippingCost: "0", deliveryDays: 5, rating: 5, orderCount: 90000, isAvailable: true },
      ],
      costOnly,
    );
    expect(scored[0].id).toBe("cheap-slow");
  });
});

describe("isWorthSwitching", () => {
  const scoredFor = (altItem: string) =>
    scoreCandidates([
      { id: "current", itemCost: "12.00", shippingCost: "3.00", ...base, isCurrent: true },
      { id: "alt", itemCost: altItem, shippingCost: "3.00", ...base },
    ]);

  it("suggests a switch when the saving is material", () => {
    expect(isWorthSwitching(scoredFor("8.00"))?.id).toBe("alt");
  });

  it("stays quiet about pennies", () => {
    expect(isWorthSwitching(scoredFor("11.90"))).toBeNull();
  });

  it("stays quiet when there is no current supplier", () => {
    const scored = scoreCandidates([{ id: "a", itemCost: "5", shippingCost: "0", ...base }]);
    expect(isWorthSwitching(scored)).toBeNull();
  });
});
