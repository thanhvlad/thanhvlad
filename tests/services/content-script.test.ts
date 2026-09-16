/**
 * extension/content.js, the panel on the supplier's product page.
 *
 * The page reader stops at 250 variants so every capture stays pushable to
 * Shopify. The panel must say when that left variants out, and stay silent
 * otherwise, so a merchant does not discover missing colours in the store.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(resolve(__dirname, "../../extension/content.js"), "utf8");

/** Evaluate the content script against a page that is not a product page, and hand back one of its functions. */
function loadVariantsLeftOut(): (captured: unknown) => string {
  const document = { readyState: "complete", getElementById: () => null, body: { appendChild: vi.fn() } };
  const location = { href: "https://www.aliexpress.com/" };
  // The extension ships as a classic script; its top-level function declarations
  // are reachable by returning one from the evaluated body.
  // eslint-disable-next-line no-new-func
  const run = new Function("document", "location", "setInterval", "chrome", "window", `${SOURCE}\nreturn variantsLeftOut;`);
  return run(document, location, vi.fn(), {}, new EventTarget());
}

describe("content script variant note", () => {
  const variantsLeftOut = loadVariantsLeftOut();
  const variants = (n: number) => Array.from({ length: n }, (_, i) => ({ externalSkuId: String(i) }));

  it("names how many variants were left out of a capped capture", () => {
    expect(variantsLeftOut({ variants: variants(250), variantCount: 312 })).toBe(
      " Only the first 250 of 312 variants were added, the most one import can send to Shopify.",
    );
  });

  it("says nothing when every variant was sent, or when an older reader sent no count", () => {
    expect(variantsLeftOut({ variants: variants(12), variantCount: 12 })).toBe("");
    expect(variantsLeftOut({ variants: variants(12) })).toBe("");
    expect(variantsLeftOut(null)).toBe("");
  });
});
