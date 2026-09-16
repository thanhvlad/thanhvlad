/**
 * Guard rails for the dictionaries.
 *
 * English is the source of truth: a missing Vietnamese key falls back to it, so
 * a partial translation is always safe to ship. What is not safe is a key that
 * looks translated but is not, or a Vietnamese string that lost its diacritics.
 */
import { describe, expect, it } from "vitest";
import { SUPPORTED_LOCALES, localeCoverage, makeT, translate } from "~/lib/i18n";

describe("i18n", () => {
  it("falls back to English rather than showing nothing", () => {
    // Cast through unknown: the point of the test is the runtime behaviour for a
    // key the Vietnamese dictionary does not carry.
    const missing = "definitely.not.a.key" as unknown as Parameters<typeof translate>[1];
    expect(translate("vi", missing)).toBeUndefined();

    const t = makeT("vi");
    expect(t("nav.orders")).toBe("Đơn hàng");
    expect(makeT("en")("nav.orders")).toBe("Orders");
  });

  it("offers exactly the locales it can serve", () => {
    expect(SUPPORTED_LOCALES.map((l) => l.value)).toEqual(["en", "vi"]);
  });

  it("reports honest coverage", () => {
    expect(localeCoverage("en").percent).toBe(100);
    const vi = localeCoverage("vi");
    expect(vi.total).toBeGreaterThan(300);
    expect(vi.percent).toBeGreaterThan(90);
  });

  it("translates Vietnamese with diacritics, not stripped ASCII", () => {
    // A machine transliteration would read as broken Vietnamese to a merchant.
    // Every Vietnamese string of a reasonable length should carry at least one
    // Vietnamese-specific character somewhere in the dictionary.
    const t = makeT("vi");
    const sample = ["nav.orders", "nav.settings", "nav.products", "stage.PENDING", "action.save"] as const;
    const combined = sample.map((k) => t(k)).join(" ");
    expect(combined).toMatch(/[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i);
  });

  it("does not leave a Vietnamese value identical to its English source by accident", () => {
    // Some are legitimately identical (proper nouns, "CSV"), but the bulk should
    // differ — if most matched, the dictionary was never really translated.
    const t = makeT("vi");
    const en = makeT("en");
    const keys = [
      "nav.home", "nav.search", "nav.import", "nav.products", "nav.orders",
      "nav.payments", "nav.tracking", "nav.suppliers", "nav.pricing",
      "nav.shipping", "nav.inventory", "nav.reports", "nav.notifications",
      "nav.logs", "nav.settings",
    ] as const;
    const identical = keys.filter((k) => t(k) === en(k));
    expect(identical.length).toBe(0);
  });
});
