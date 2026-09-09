import { describe, expect, it } from "vitest";
import { canonical, matchVariants, normalize, splitLabel, valueSimilarity, variantSimilarity } from "~/domain/mapping/match";

describe("normalize / canonical", () => {
  it("strips case, diacritics and punctuation", () => {
    expect(normalize("  Đỏ-Tươi! ")).toBe("do tuoi");
    expect(normalize("X-Large")).toBe("x large");
  });

  it("maps synonyms across languages to one canonical form", () => {
    expect(canonical("Black")).toBe("black");
    expect(canonical("đen")).toBe("black");
    expect(canonical("黑色")).toBe("black");
    expect(canonical("Extra Large")).toBe("xl");
    expect(canonical("2XL")).toBe("xxl");
    expect(canonical("China")).toBe("cn");
  });

  it("finds a synonym inside a longer phrase", () => {
    expect(canonical("Black 2pcs")).toBe("black");
    expect(canonical("gold plated")).toBe("gold");
  });

  it("leaves unknown values normalised but unchanged", () => {
    expect(canonical("Type A")).toBe("type a");
  });
});

describe("valueSimilarity", () => {
  it("scores identical and equivalent values highest", () => {
    expect(valueSimilarity("Red", "red")).toBe(1);
    expect(valueSimilarity("Black", "Đen")).toBeCloseTo(0.97, 2);
    expect(valueSimilarity("XL", "Extra Large")).toBeCloseTo(0.97, 2);
  });

  it("rejects values whose numbers disagree", () => {
    expect(valueSimilarity("50cm", "60cm")).toBe(0);
    expect(valueSimilarity("2 Pcs", "3 Pcs")).toBe(0);
    expect(valueSimilarity("50cm", "50 cm")).toBe(1);
  });

  it("scores substrings and shared tokens in between", () => {
    expect(valueSimilarity("Navy", "Navy Blue")).toBeGreaterThan(0.8);
    expect(valueSimilarity("Rose Gold", "Gold Rose")).toBeGreaterThan(0.8);
  });

  it("gives nothing for unrelated values", () => {
    expect(valueSimilarity("Red", "Wooden Handle")).toBe(0);
  });
});

describe("variantSimilarity", () => {
  it("ignores option order", () => {
    expect(variantSimilarity(["Red", "XL"], ["XL", "Red"])).toBe(1);
  });

  it("penalises a different number of options but still matches", () => {
    const score = variantSimilarity(["Red"], ["Red", "China"]);
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThan(1);
  });

  it("is zero when nothing lines up", () => {
    expect(variantSimilarity(["Red", "XL"], ["Wood", "Large Kit"])).toBeLessThan(0.4);
  });
});

describe("matchVariants", () => {
  const targets = [
    { id: "v-red-s", values: ["Red", "S"] },
    { id: "v-red-l", values: ["Red", "L"] },
    { id: "v-black-s", values: ["Black", "S"] },
  ];
  const candidates = [
    { id: "sku-1", values: ["S", "Đỏ"] },
    { id: "sku-2", values: ["Large", "Red"] },
    { id: "sku-3", values: ["Small", "Black"] },
    { id: "sku-4", values: ["Large", "Black"] },
  ];

  it("assigns each variant its equivalent SKU across languages and order", () => {
    const result = matchVariants(targets, candidates);
    const byTarget = Object.fromEntries(result.assignments.map((a) => [a.targetId, a.candidateId]));
    expect(byTarget["v-red-s"]).toBe("sku-1");
    expect(byTarget["v-red-l"]).toBe("sku-2");
    expect(byTarget["v-black-s"]).toBe("sku-3");
    expect(result.unmatched).toEqual([]);
    expect(result.assignments.every((a) => a.confidence > 0.9)).toBe(true);
  });

  it("never reuses one SKU for two variants by default", () => {
    const result = matchVariants(targets, [candidates[0]]);
    const used = result.assignments.filter((a) => a.candidateId).map((a) => a.candidateId);
    expect(new Set(used).size).toBe(used.length);
    expect(result.unmatched.length).toBe(2);
  });

  it("can reuse when asked", () => {
    const result = matchVariants(targets, [{ id: "only", values: ["Red", "S"] }], { allowReuse: true, threshold: 0.3 });
    expect(result.assignments.filter((a) => a.candidateId === "only").length).toBeGreaterThan(1);
  });

  it("maps a single SKU to a single variant with full confidence", () => {
    const result = matchVariants([{ id: "v", values: ["Default Title"] }], [{ id: "sku", values: [] }]);
    expect(result.assignments[0]).toMatchObject({ candidateId: "sku", confidence: 1 });
  });

  it("leaves genuinely unmatched variants open instead of guessing", () => {
    const result = matchVariants([{ id: "v", values: ["Titanium Frame"] }], [{ id: "sku", values: ["Cotton Bag"] }]);
    expect(result.assignments[0].candidateId).toBeNull();
    expect(result.unmatched).toHaveLength(1);
  });

  it("is order-independent", () => {
    const a = matchVariants(targets, candidates);
    const b = matchVariants([...targets].reverse(), [...candidates].reverse());
    const norm = (r: typeof a) => r.assignments.map((x) => `${x.targetId}:${x.candidateId}`).sort();
    expect(norm(a)).toEqual(norm(b));
  });

  it("prefers an in-stock SKU when scores tie", () => {
    const result = matchVariants(
      [{ id: "v", values: ["Red"] }],
      [
        { id: "out", values: ["Red"], isAvailable: false },
        { id: "in", values: ["Red"], isAvailable: true },
      ],
    );
    expect(result.assignments[0].candidateId).toBe("in");
  });

  it("falls back to the variant title when there are no option values", () => {
    expect(splitLabel("Red / XL")).toEqual(["Red", "XL"]);
    const result = matchVariants([{ id: "v", values: [], label: "Red / XL" }], [{ id: "s1", values: [], label: "XL / Red" }, { id: "s2", values: ["Blue", "S"] }]);
    expect(result.assignments[0].candidateId).toBe("s1");
  });
});
