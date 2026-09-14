import { describe, expect, it } from "vitest";
import { brandText, buildWritingContract, exampleFitsBrand, resolveStoreBrand, signOffFrom } from "~/domain/copy/lumora-contract";

/**
 * The writing contract used to be a constant written for the owner's store, so
 * every merchant's pages were signed "Lumora Loves" and pointed at
 * support@lumoraloves.com. These pin that the store-specific parts now come
 * from the store itself, and that the owner's own pages still come out the same.
 */

const LUMORA_TAGLINE = "Home &amp; lifestyle pieces chosen to make everyday jobs a little easier — and everyday living a little warmer.";

function finishedPage(brand: string, tagline: string | null, email?: string) {
  return [
    '<div style="max-width:1080px;margin:0 auto;color:#2b2b2b;line-height:1.7">',
    "<p>Body.</p>",
    email ? `<p>Email <a href="mailto:${email}" style="color:#A84663">${email}</a> to start a return.</p>` : "",
    '<div style="text-align:center;padding:26px 0 6px">',
    `  <p style="color:#A84663;font-size:12px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;margin:0 0 8px">${brand}</p>`,
    tagline ? `  <p style="margin:0;max-width:620px;display:inline-block;font-size:15px;color:#6b6b6b">${tagline}</p>` : "",
    "</div>",
    "</div>",
  ].join("\n");
}

describe("buildWritingContract", () => {
  it("writes another merchant's pages under their own name and address", () => {
    const contract = buildWritingContract({ name: "Harbor & Pine", supportEmail: "hello@harborpine.com", signOffTagline: null });
    expect(contract).not.toMatch(/lumora/i);
    expect(contract).toContain("a finished Harbor &amp; Pine landing page");
    expect(contract).toContain("mailto:hello@harborpine.com");
    // No sign-off sentence is invented for a store that never wrote one.
    expect(contract).not.toContain("everyday living a little warmer");
  });

  it("gives a store with no public address no link at all", () => {
    const contract = buildWritingContract({ name: "Quiet Goods", supportEmail: null, signOffTagline: null });
    expect(contract).not.toContain("mailto:");
    expect(contract).toContain("no <a> element at all");
  });

  it("no longer promises a returns policy the store never configured", () => {
    const contract = buildWritingContract({ name: "Quiet Goods", supportEmail: "a@b.co", signOffTagline: null });
    expect(contract).not.toContain("30-day returns");
    expect(contract).toContain("{RETURNS_TERMS}");
  });

  it("keeps the owner's sign-off when the owner's store supplies it", () => {
    const contract = buildWritingContract({ name: "Lumora Loves", supportEmail: "support@lumoraloves.com", signOffTagline: LUMORA_TAGLINE });
    expect(contract).toContain(`margin:0 0 8px">Lumora Loves</p>`);
    expect(contract).toContain(LUMORA_TAGLINE);
    expect(contract).toContain("the ONLY legal href value in the entire store is `mailto:support@lumoraloves.com`");
  });
});

describe("brandText", () => {
  it("keeps a name plain text with only the one permitted entity", () => {
    expect(brandText("Harbor & Pine")).toBe("Harbor &amp; Pine");
    expect(brandText("Harbor &amp; Pine")).toBe("Harbor &amp; Pine");
    expect(brandText('<b>Bold</b> "Co"')).toBe("bBold/b Co");
  });
});

describe("signOffFrom", () => {
  it("reads the brand and sentence from a finished page", () => {
    expect(signOffFrom(finishedPage("Lumora Loves", LUMORA_TAGLINE))).toEqual({ name: "Lumora Loves", tagline: LUMORA_TAGLINE });
    expect(signOffFrom(finishedPage("Quiet Goods", null))).toEqual({ name: "Quiet Goods", tagline: null });
  });

  it("returns null for a page with no sign-off", () => {
    expect(signOffFrom("<p>Supplier text</p>")).toBeNull();
  });
});

describe("exampleFitsBrand", () => {
  it("drops a page another brand signed, so its name is not copied", () => {
    expect(exampleFitsBrand(finishedPage("Lumora Loves", LUMORA_TAGLINE), "Harbor & Pine")).toBe(false);
    expect(exampleFitsBrand(finishedPage("Harbor &amp; Pine", null), "Harbor & Pine")).toBe(true);
    expect(exampleFitsBrand("<p>No sign-off</p>", "Harbor & Pine")).toBe(true);
  });
});

describe("resolveStoreBrand", () => {
  it("takes the name and public contact email from Shopify", () => {
    const brand = resolveStoreBrand({ shopName: "Harbor & Pine", domain: "harbor.myshopify.com", contactEmail: " Hello@HarborPine.com ", examples: [] });
    expect(brand).toEqual({ name: "Harbor & Pine", supportEmail: "hello@harborpine.com", signOffTagline: null });
  });

  it("reproduces the owner's values from the owner's own pages", () => {
    const brand = resolveStoreBrand({
      shopName: "Lumora Loves",
      domain: "lumora.myshopify.com",
      contactEmail: "support@lumoraloves.com",
      examples: [{ descriptionHtml: finishedPage("Lumora Loves", LUMORA_TAGLINE, "support@lumoraloves.com") }],
    });
    expect(brand).toEqual({ name: "Lumora Loves", supportEmail: "support@lumoraloves.com", signOffTagline: LUMORA_TAGLINE });
  });

  it("prefers the merchant's own setting, then Shopify's contact email", () => {
    const base = { shopName: "Quiet Goods", domain: "q.myshopify.com", examples: [] };
    expect(resolveStoreBrand({ ...base, settingsEmail: " Care@QuietGoods.com ", contactEmail: "owner@quietgoods.com" }).supportEmail).toBe("care@quietgoods.com");
    // An empty or unusable setting does not hide Shopify's address.
    expect(resolveStoreBrand({ ...base, settingsEmail: "", contactEmail: "owner@quietgoods.com" }).supportEmail).toBe("owner@quietgoods.com");
    expect(resolveStoreBrand({ ...base, settingsEmail: "not an address", contactEmail: "owner@quietgoods.com" }).supportEmail).toBe("owner@quietgoods.com");
    // The setting still applies when Shopify could not be asked.
    expect(resolveStoreBrand({ ...base, settingsEmail: "care@quietgoods.com", contactEmail: undefined }).supportEmail).toBe("care@quietgoods.com");
  });

  it("never borrows a tagline or address from a page signed by another brand", () => {
    // A merchant whose early rewrites were signed with the owner's brand.
    const brand = resolveStoreBrand({
      shopName: "Harbor & Pine",
      domain: "harbor.myshopify.com",
      contactEmail: undefined,
      examples: [{ descriptionHtml: finishedPage("Lumora Loves", LUMORA_TAGLINE, "support@lumoraloves.com") }],
    });
    expect(brand).toEqual({ name: "Harbor & Pine", supportEmail: null, signOffTagline: null });
  });

  it("prints no address when neither the setting nor Shopify gives one", () => {
    // Even the store's own older page is not a source: the address on it may
    // be one the merchant has since retired.
    const examples = [{ descriptionHtml: finishedPage("Quiet Goods", "A tagline.", "care@quietgoods.com") }];
    const unreachable = resolveStoreBrand({ shopName: "Quiet Goods", domain: "q.myshopify.com", settingsEmail: "", contactEmail: undefined, examples });
    expect(unreachable).toEqual({ name: "Quiet Goods", supportEmail: null, signOffTagline: "A tagline." });
    expect(resolveStoreBrand({ shopName: "Quiet Goods", domain: "q.myshopify.com", contactEmail: "", examples }).supportEmail).toBeNull();
    expect(resolveStoreBrand({ shopName: "Quiet Goods", domain: "q.myshopify.com", contactEmail: null, examples }).supportEmail).toBeNull();
    // With no address the contract permits no link at all.
    expect(buildWritingContract(unreachable)).not.toMatch(/mailto:/);
  });

  it("names a store with no name after its domain", () => {
    expect(resolveStoreBrand({ shopName: null, domain: "quiet-goods.myshopify.com", contactEmail: null, examples: [] }).name).toBe("quiet-goods");
  });
});
