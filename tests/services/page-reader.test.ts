/**
 * extension/page-reader.js, run against a recorded shape of the AliExpress
 * product model.
 *
 * The first real product pushed to a store had an empty description, because
 * the reader sent "" on purpose. It now fetches the description the model links
 * to and builds a specification table, and it must never let either cost the
 * merchant the capture itself.
 *
 * There is no DOM in this test run, so the reader's DOMParser branch is not
 * exercised here; it takes its regex fallback, which is the same contract.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CapturedProduct } from "~/services/suppliers/captured.server";

const SOURCE = readFileSync(resolve(__dirname, "../../extension/page-reader.js"), "utf8");

type FetchStub = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; text: () => Promise<string> }>;

function model(overrides: Record<string, unknown> = {}) {
  return {
    GLOBAL_DATA: { globalData: { productInfo: { productId: "1005006001", detailUrl: "https://www.aliexpress.com/item/1005006001.html", categoryId: 200000 } } },
    PRODUCT_TITLE: { text: "Cotton tee" },
    HEADER_IMAGE_PC: { imagePathList: ["https://ae01.alicdn.com/kf/a.jpg"] },
    SKU: {
      skuProperties: [{ skuPropertyId: 14, skuPropertyName: "Color", skuPropertyValues: [{ propertyValueIdLong: 691, propertyValueDisplayName: "Black" }] }],
      skuPaths: [{ skuIdStr: "12000001", path: "14:691", skuStock: 20, salable: true }],
    },
    PRICE: { skuPriceInfoMap: { "12000001": { salePriceLocal: "$3.50|3.5|", originalPrice: { value: 5, currency: "USD" } } } },
    DESC: {
      pcDescUrl: "https://pdp.aliexpress-media.com/product/description/pc/v2/en_US/desc.htm?productId=1005006001&key=k",
      nativeDescUrl: "https://pdp.aliexpress-media.com/product/description/native/v2/en_US/desc.json?productId=1005006001&key=k",
    },
    PRODUCT_PROP_PC: {
      showedProps: [
        { attrName: "Brand Name", attrValue: "NONE" },
        { attrName: "Material", attrValue: "Cotton" },
        { attrName: "Origin", attrValue: "Mainland China" },
        { attrName: "semi_Choice", attrValue: "yes" },
        { attrName: "Sleeve Length(cm)", attrValue: "Short" },
        { attrName: "Material", attrValue: "Cotton" },
        { attrName: "<img src=x onerror=alert(1)>", attrValue: "Soft & <b>light</b>" },
        { attrName: "t shirt women summer tops", attrValue: "t shirt women summer tops" },
        { attrName: "oversized tee cotton", attrValue: "tshirt, tee, top, women, summer, casual, loose" },
        { attrName: "Womens Graphic Tees Summer Casual Short Sleeve Tops", attrValue: "Yes" },
      ],
    },
    ...overrides,
  };
}

/** Load the reader into a fake main world and ask it for the product. */
async function readProduct(data: unknown, fetchStub: FetchStub, hostname = "www.aliexpress.com") {
  const win = new EventTarget() as EventTarget & { _d_c_?: unknown };
  win._d_c_ = { lifeCycleEventList: [{ data }] };
  const location = { hostname, href: `https://${hostname}/item/1005006001.html` };
  // The extension ships as a plain browser script, not a module; evaluating its
  // source with the page globals as parameters is how it runs in the MAIN world.
  // eslint-disable-next-line no-new-func
  const run = new Function("window", "location", "fetch", "DOMParser", SOURCE);
  run(win, location, fetchStub, undefined);

  const events: string[] = [];
  const result = new Promise<Record<string, unknown> | null>((done) => {
    win.addEventListener("dropshiphub:reading", () => events.push("ack"));
    win.addEventListener("dropshiphub:product", (event) => {
      const detail = (event as CustomEvent<string>).detail;
      done(detail ? JSON.parse(detail) : null);
    });
  });
  win.dispatchEvent(new CustomEvent("dropshiphub:read"));
  expect(events).toEqual(["ack"]);
  return result;
}

const respond = (body: string, ok = true) => Promise.resolve({ ok, text: () => Promise.resolve(body) });

describe("page reader description capture", () => {
  it("sends the description document's body followed by a clean specification table", async () => {
    const requested: string[] = [];
    const product = await readProduct(model(), (url) => {
      requested.push(url);
      return respond(`<html><head><script>track()</script></head><body><div class="detailmodule_html"><p>Soft cotton.</p><img src="https://ae01.alicdn.com/kf/d.jpg"></div></body></html>`);
    });
    expect(requested).toEqual([model().DESC.pcDescUrl]);
    const html = String(product?.descriptionHtml);
    expect(html).toContain("<p>Soft cotton.</p>");
    expect(html).not.toContain("track()");
    expect(html).toContain("<h3>Specifications</h3>");
    expect(html).toContain("<tr><th>Material</th><td>Cotton</td></tr>");
    expect(html).toContain("<tr><th>Origin</th><td>Mainland China</td></tr>");
    expect(html.match(/<th>Material<\/th>/g)).toHaveLength(1);
    // Keyword stuffing, internal flags and "NONE" values are not specifications.
    expect(html).not.toContain("NONE");
    expect(html).not.toContain("semi_Choice");
    expect(html).not.toContain("t shirt women summer tops");
    expect(html).not.toContain("oversized tee cotton");
    expect(html).not.toContain("Womens Graphic Tees");
  });

  it("escapes specification text instead of passing markup through", async () => {
    const product = await readProduct(
      model({ DESC: {}, PRODUCT_PROP_PC: { showedProps: [{ attrName: "Care", attrValue: "Soft & <b>light</b>" }, { attrName: "<i>x</i>", attrValue: "y" }] } }),
      () => respond(""),
    );
    const html = String(product?.descriptionHtml);
    expect(html).toContain("<td>Soft &amp; &lt;b&gt;light&lt;/b&gt;</td>");
    expect(html).toContain("<th>&lt;i&gt;x&lt;/i&gt;</th>");
  });

  it("falls back to the image and text modules when the HTML document fails", async () => {
    const product = await readProduct(model({ PRODUCT_PROP_PC: undefined }), (url) =>
      url.includes("/pc/")
        ? respond("", false)
        : respond(JSON.stringify({ moduleList: [{ type: "image", data: { url: "https://ae01.alicdn.com/kf/m.jpg" } }, { type: "text", data: { content: "Line one\nLine <two>" } }] })),
    );
    expect(product?.descriptionHtml).toBe('<p><img src="https://ae01.alicdn.com/kf/m.jpg" alt=""></p>\n<p>Line one<br>Line &lt;two&gt;</p>');
  });

  it("stops at 250 variants, the most one Shopify input array takes, and says how many the page had", async () => {
    const skuPaths = Array.from({ length: 260 }, (_, i) => ({ skuIdStr: String(13000000 + i), path: "14:691", skuStock: 5, salable: true }));
    const skuPriceInfoMap = Object.fromEntries(skuPaths.map((row) => [row.skuIdStr, { salePriceLocal: "$3.50|3.5|", originalPrice: { value: 5, currency: "USD" } }]));
    const base = model();
    const product = await readProduct(
      model({ SKU: { ...base.SKU, skuPaths }, PRICE: { skuPriceInfoMap }, PRODUCT_PROP_PC: undefined, DESC: {} }),
      () => respond(""),
    );
    expect(product?.variants).toHaveLength(250);
    expect(product?.variantCount).toBe(260);
    // The server's capture schema must accept what the reader sends, or the whole capture is refused.
    const parsed = CapturedProduct.safeParse(product);
    expect(parsed.success).toBe(true);
  });

  it("still captures the product when every description request fails", async () => {
    const product = await readProduct(model({ PRODUCT_PROP_PC: undefined }), () => Promise.reject(new TypeError("Failed to fetch")));
    expect(product?.title).toBe("Cotton tee");
    expect(product?.variants).toHaveLength(1);
    expect(product?.descriptionHtml).toBe("");
  });

  it("does not follow a description url off AliExpress's own hosts", async () => {
    const requested: string[] = [];
    const product = await readProduct(
      model({ DESC: { pcDescUrl: "https://evil.example/desc.htm", nativeDescUrl: "http://pdp.aliexpress-media.com/desc.json" }, PRODUCT_PROP_PC: undefined }),
      (url) => {
        requested.push(url);
        return respond("<p>x</p>");
      },
    );
    expect(requested).toEqual([]);
    expect(product?.descriptionHtml).toBe("");
  });

  it("gives up on a description that never arrives, and sends the product without it", async () => {
    const started = Date.now();
    const product = await readProduct(model({ PRODUCT_PROP_PC: undefined }), (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    expect(product?.title).toBe("Cotton tee");
    expect(product?.descriptionHtml).toBe("");
    expect(Date.now() - started).toBeLessThan(7000);
  }, 10_000);

  it("answers null off AliExpress", async () => {
    expect(await readProduct(model(), () => respond("<p>x</p>"), "example.com")).toBeNull();
  });
});
