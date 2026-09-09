import { describe, expect, it } from "vitest";
import { checkHtml, checkRewrite, checkTitle, tailClauseCount, visibleText } from "~/domain/copy/check-rewrite";

const GOOD_TITLE = "2-in-1 Fan Water Bottle — 690 ml with Detachable 3-Speed Fan";

/** A body that satisfies every countable rule, so each test can break one. */
function body(words = 1000, extra = ""): string {
  const sentence = "The pump sits inside the grip and draws water through a mesh filter. ";
  const filler = sentence.repeat(Math.ceil(words / 13));
  return `<div style="max-width:1080px"><p>${filler}</p><img src="https://x/1.jpg" alt="The bottle on a bench">${extra}</div>`;
}

function input(over: Partial<Parameters<typeof checkRewrite>[0]> = {}) {
  return {
    title: GOOD_TITLE,
    descriptionHtml: body(),
    tags: ["fan", "water bottle", "commuter", "summer", "usb-c", "travel", "gym", "festival"],
    heroImageIndex: 0,
    imageCount: 6,
    ...over,
  };
}

describe("title rules", () => {
  it("accepts a title from the store's own corpus", () => {
    expect(checkTitle(GOOD_TITLE)).toEqual([]);
  });

  it("rejects a second em dash", () => {
    const failures = checkTitle("Fan Water Bottle — 690 ml — With a Detachable Three Speed Fan Unit");
    expect(failures.some((f) => f.includes("em dashes"))).toBe(true);
  });

  it("rejects a pipe, a colon and terminal punctuation", () => {
    expect(checkTitle("Fan Water Bottle — 690 ml, Detachable Fan | Renter Friendly").some((f) => f.includes("| : or ;"))).toBe(true);
    expect(checkTitle("Fan Water Bottle — 690 ml with a Detachable Three-Speed Fan.").some((f) => f.includes("terminal punctuation"))).toBe(true);
  });

  it("rejects a comma in the head", () => {
    const failures = checkTitle("Fan Water Bottle, Sport Flask — 690 ml with a Detachable Fan Unit");
    expect(failures.some((f) => f.includes("head contains a comma"))).toBe(true);
  });

  it("rejects a fourth clause in the tail", () => {
    const failures = checkTitle("Fan Water Bottle — 690 ml, Cold Air, Timer, USB-C Rechargeable Unit");
    expect(failures.some((f) => f.includes("clauses"))).toBe(true);
  });

  it("does not count a thousands separator as a clause", () => {
    // The corpus title that first exposed this: "Covers Up to 3,500 sq ft".
    expect(tailClauseCount(" Waterless Cold-Air, 500ml, Covers Up to 3,500 sq ft")).toBe(3);
  });

  it("rejects a title outside 51 to 81 characters", () => {
    expect(checkTitle("Fan Bottle — 690 ml").some((f) => f.includes("characters"))).toBe(true);
  });
});

describe("html rules", () => {
  it("rejects a tag the store never uses", () => {
    expect(checkHtml("<div><span>hello</span></div>").some((f) => f.includes("<span>"))).toBe(true);
  });

  it("rejects class, id and event handlers", () => {
    expect(checkHtml('<div class="wrap"></div>').some((f) => f.includes("Forbidden attribute"))).toBe(true);
    expect(checkHtml('<img src="a" alt="b" onerror="x()">').some((f) => f.includes("Forbidden attribute"))).toBe(true);
  });

  it("rejects any href but the support address", () => {
    expect(checkHtml('<a href="https://evil.example">x</a>').some((f) => f.includes("only permitted href"))).toBe(true);
    expect(checkHtml('<a href="mailto:support@lumoraloves.com">x</a>')).toEqual([]);
  });

  it("rejects an image with no alt", () => {
    expect(checkHtml('<img src="https://x/1.jpg">').some((f) => f.includes("no descriptive alt"))).toBe(true);
  });
});

describe("whole-page checks", () => {
  it("passes a page that satisfies every countable rule", () => {
    const result = checkRewrite(input());
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("catches the supplier register this feature exists to remove", () => {
    // The exact opener from the store's own unrewritten pet-bottle import.
    const bad = body(1000, "<p>Make outdoor adventures with your furry friend effortless.</p>");
    const result = checkRewrite(input({ descriptionHtml: bad }));
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("effortless"))).toBe(true);
  });

  it("catches an outcome promise and a grading adjective", () => {
    const bad = body(1000, "<p>Our premium design ensures your pet stays hydrated.</p>");
    const failures = checkRewrite(input({ descriptionHtml: bad })).failures;
    expect(failures.some((f) => f.includes("premium"))).toBe(true);
    expect(failures.some((f) => f.includes("outcome promise"))).toBe(true);
  });

  it("rejects a body that is too short or too long", () => {
    expect(checkRewrite(input({ descriptionHtml: body(200) })).failures.some((f) => f.includes("at least 900"))).toBe(true);
    expect(checkRewrite(input({ descriptionHtml: body(2600) })).failures.some((f) => f.includes("at most 2,100"))).toBe(true);
  });

  it("rejects exclamation marks and emoji", () => {
    expect(checkRewrite(input({ descriptionHtml: body(1000, "<p>It works!</p>") })).failures.some((f) => f.includes("exclamation"))).toBe(true);
    expect(checkRewrite(input({ descriptionHtml: body(1000, "<p>It works \u{1F600}</p>") })).failures.some((f) => f.includes("emoji"))).toBe(true);
  });

  it("enforces the tag count and lowercase rule", () => {
    expect(checkRewrite(input({ tags: ["one", "two"] })).failures.some((f) => f.includes("8 to 12"))).toBe(true);
    expect(checkRewrite(input({ tags: ["Fan", "water bottle", "commuter", "summer", "usb-c", "travel", "gym", "festival"] })).failures.some((f) => f.includes("lowercase"))).toBe(true);
  });

  it("rejects a hero index outside the supplied images", () => {
    expect(checkRewrite(input({ heroImageIndex: 9, imageCount: 6 })).failures.some((f) => f.includes("outside"))).toBe(true);
  });

  it("warns about contractions without blocking the page", () => {
    const result = checkRewrite(input({ descriptionHtml: body(1000, "<p>It does not leak and you cannot overfill it, but it isn't a flask.</p>") }));
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("contraction"))).toBe(true);
  });

  it("strips markup before measuring prose", () => {
    expect(visibleText('<p>Hello <strong>there</strong></p>')).toBe("Hello there");
  });
});
