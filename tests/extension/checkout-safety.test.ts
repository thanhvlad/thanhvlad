/**
 * The checkout assist's safety rules, checked against the files the extension
 * ships. The click classifier itself is tested in checkout-core.test.ts; these
 * make sure nothing in the content script goes around it, and that customer
 * data has no path to the console, a URL, persistent storage or the page.
 */
import { describe, expect, it } from "vitest";
import { extensionFile } from "./load-core";

const checkout = extensionFile("checkout.js");
const background = extensionFile("background.js");
const core = extensionFile("checkout-core.js");
const pageReader = extensionFile("page-reader.js");
const manifest = JSON.parse(extensionFile("manifest.json"));

/**
 * A function's source, from its declaration to the closing brace at its own
 * indent: two spaces inside checkout.js's wrapping IIFE, none in background.js.
 */
function functionSource(source: string, name: string, indent = "  "): string {
  const text = source.replace(/\r\n/g, "\n");
  const start = text.indexOf(`function ${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  const close = `\n${indent}}\n`;
  const end = text.indexOf(close, start);
  expect(end, `${name} has a closing brace`).toBeGreaterThan(start);
  return text.slice(start, end + close.length);
}

function count(source: string, pattern: RegExp): number {
  return (source.match(new RegExp(pattern.source, "g")) ?? []).length;
}

describe("clicks go through the guard only", () => {
  it("has exactly one programmatic click, inside guardedClick, after the classifier", () => {
    const guard = functionSource(checkout, "guardedClick");
    expect(count(checkout, /\.click\(/)).toBe(1);
    expect(count(guard, /\.click\(/)).toBe(1);
    expect(count(checkout, /new MouseEvent\(/)).toBe(1);
    expect(count(guard, /new MouseEvent\(/)).toBe(1);
    expect(guard.indexOf("core.clickRefusal(")).toBeGreaterThan(-1);
    expect(guard.indexOf("core.clickRefusal(")).toBeLessThan(guard.indexOf("dispatchEvent("));
    expect(guard.indexOf("if (refusal) return refusal;")).toBeLessThan(guard.indexOf(".click("));
  });

  it("judges every control around the clicked element that the click would activate", () => {
    const describer = functionSource(checkout, "describeForGuard");
    const guard = functionSource(checkout, "guardedClick");
    // guardedClick classifies the descriptor that carries the activators.
    expect(guard).toContain("core.clickRefusal(describeForGuard(element))");
    // Every ancestor up to the document, not only the nearest one.
    expect(describer).toMatch(/for \(let node = element\.parentElement; node; node = node\.parentElement\)/);
    expect(describer).toContain("node.matches(ACTIVATORS)");
    expect(describer).toContain("activators");
    for (const selector of ["button", "input", "label", "summary", "a[href]", '[role="button"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]', "[aria-checked]"]) {
      expect(checkout).toMatch(new RegExp(`const ACTIVATORS =\\s*'[^']*${selector.replace(/[[\]()]/g, "\\$&")}`));
    }
    // A label is judged with the control it toggles.
    expect(functionSource(checkout, "describeElement")).toMatch(/element instanceof HTMLLabelElement && element\.control/);
    expect(core).toMatch(/for \(const activator of Array\.isArray\(d\.activators\)/);
  });

  it('hands the guard the control around "Enter manually", not the span inside it', () => {
    expect(functionSource(checkout, "enterManuallyIfNeeded")).toContain(`guardedClick(link.closest("button, a, [role='button']") ?? link)`);
  });

  it("never submits a form, presses a key or dispatches pointer events elsewhere", () => {
    for (const source of [checkout, core, background]) {
      expect(source).not.toMatch(/\.submit\(|requestSubmit|KeyboardEvent|PointerEvent|TouchEvent|new Event\("submit"/);
    }
  });

  it("dispatches only input and change events on the address form's inputs, from one function", () => {
    const setter = functionSource(checkout, "setInputValue");
    expect(setter).toContain('input.closest("form.deliver-address-form")');
    expect(count(checkout, /new Event\(/)).toBe(2);
    expect(count(setter, /new Event\("input"/)).toBe(1);
    expect(count(setter, /new Event\("change"/)).toBe(1);
  });

  it("never ticks a checkbox on the page", () => {
    const assignments = checkout.match(/\w+\.checked\s*=(?!=)[^;]*/g) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    // Only the panel's own "I have paid" box, created by this script.
    for (const line of assignments) expect(line).toBe("paid.checked = true");
  });

  it("fills the address only from the Fill address button", () => {
    expect(count(checkout, /fillAddress\(/)).toBe(2);
    const handler = checkout.slice(checkout.indexOf('button("Fill address"'), checkout.indexOf("const record = recordBlock(job);"));
    expect(handler).toContain("await fillAddress(job, values, fillStatus);");
    // Every panel button ignores clicks that are not the merchant's own.
    const helper = functionSource(checkout, "button");
    expect(helper).toContain("if (!event.isTrusted) return;");
    expect(helper.indexOf("if (!event.isTrusted) return;")).toBeLessThan(helper.indexOf("onClick(event)"));
  });

  it("reads the default box and the form's values before it types or chooses anything", () => {
    const fill = functionSource(checkout, "fillAddress");
    const refusals = [...fill.matchAll(/if \(formRefusesFill\(form, values, status, (true|false)\)\) return;/g)];
    expect(refusals.map((m) => m[1])).toEqual(["false", "true"]);
    // The first check comes before "Enter manually" and the country; the
    // whole-form check before State, City and every typed box.
    expect(fill.indexOf("formRefusesFill(")).toBeLessThan(fill.indexOf("enterManuallyIfNeeded("));
    const lastCheck = refusals[1].index ?? -1;
    for (const step of ["stateSelect, stateCandidates[0]", "chooseInSelect(citySelect", "setInputValue("]) {
      expect(fill.indexOf(step), step).toBeGreaterThan(lastCheck);
    }
    const guard = functionSource(checkout, "formRefusesFill");
    expect(guard).toContain("core.foreignFormValues(");
    expect(guard).toMatch(/if \(box === "ticked"\) \{[\s\S]*return true;/);
    expect(guard).toMatch(/if \(box === "missing" && requireBox\) \{[\s\S]*return true;/);
  });

  it('says "left unticked" only after reading the box', () => {
    const finish = functionSource(checkout, "finishFill");
    expect(count(checkout, /left unticked/)).toBe(1);
    expect(finish.indexOf("readDefaultBox(")).toBeGreaterThan(-1);
    expect(finish.indexOf("readDefaultBox(")).toBeLessThan(finish.indexOf("left unticked"));
    expect(finish).toMatch(/if \(box === "ticked"\)/);
    expect(finish).toMatch(/filledAll && !flags\.some\(Boolean\) && box === "unticked" \? "ok" : "warn"/);
  });

  it("stops the fill once the checkout is cancelled or the page moves on", () => {
    const fill = functionSource(checkout, "fillAddress");
    // Before opening the form, the country, State, City, "Other" and the typing.
    expect(count(fill, /if \(!\(await fillMayContinue\(job, status\)\)\) return;/)).toBeGreaterThanOrEqual(6);
    const check = functionSource(checkout, "fillMayContinue");
    expect(check).toContain('ask({ type: "checkout:get" })');
    expect(check).toContain("current.purchaseOrderId !== job.purchaseOrderId");
  });
});

describe("customer data stays inside the extension", () => {
  it("is never logged", () => {
    for (const source of [checkout, core, background]) expect(source).not.toMatch(/console\./);
  });

  it("builds the panel with textContent in a closed shadow root", () => {
    expect(checkout).toContain('attachShadow({ mode: "closed" })');
    for (const source of [checkout, core]) expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("is kept only in session storage, by the background worker", () => {
    expect(checkout).not.toMatch(/chrome\.storage|localStorage|sessionStorage|indexedDB/);
    expect(core).not.toMatch(/chrome\.[a-z]+\.|localStorage|sessionStorage|indexedDB/);
    expect(background).not.toMatch(/storage\.local|localStorage|indexedDB|setAccessLevel/);
    expect(background).toMatch(/chrome\.storage\.session\.set\(/);
    // The only synced read is the app URL and token the options page stores.
    expect(background.match(/storage\.sync\.[a-z]+\([^)]*\)/g)).toEqual(['storage.sync.get(["appUrl", "token"])']);
  });

  it("is sent only to the app's own placed endpoint", () => {
    expect(checkout).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
    expect(core).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
    expect(count(background, /fetch\(/)).toBe(1);
    expect(background).toMatch(/fetch\(`\$\{base\}\/api\/extension\/orders\/\$\{encodeURIComponent\(job\.purchaseOrderId\)\}\/placed`/);
  });

  it("is cleared when a checkout finishes, is cancelled, or its tab closes", () => {
    const finish = functionSource(background, "finish", "");
    expect(finish).toContain("const ended = !answer.ok && (answer.httpStatus === 404 || answer.httpStatus === 409);");
    expect(finish).toContain("if (answer.ok || ended) await dropJob(job.tabId);");
    expect(background).toMatch(/case "checkout:cancel": \{\s*await dropJob\(tabId\);/);
    expect(background).toMatch(/chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => \{\s*dropJob\(tabId\)/);
  });

  it("is cleared when the popup records the order, and when it expires without being read", () => {
    expect(functionSource(background, "forgetCheckout", "")).toContain("await sweep(purchaseOrderId);");
    // Only the extension's own pages may drop a job by purchase order.
    expect(functionSource(background, "route", "")).toMatch(/checkout:forget"\) \{\s*if \(!fromExtensionPage\(sender\)\) return/);
    expect(extensionFile("popup.js")).toMatch(/if \(\(status === 200 && answer\.ok\) \|\| status === 404 \|\| status === 409\) forgetCheckout\(order\.id\);/);
    // Expired jobs are swept on every message, and when any tab finishes loading.
    expect(background).toMatch(/chrome\.runtime\.onMessage\.addListener\([\s\S]*?sweep\(\)\s*\.catch\(\(\) => undefined\)\s*\.then\(\(\) => route\(message, sender\)\)/);
    expect(background).toMatch(/chrome\.tabs\.onUpdated\.addListener\([\s\S]*?sweep\(\)/);
    expect(background).toMatch(/chrome\.tabs\.onReplaced\.addListener/);
  });

  it("never crosses into the page's MAIN world", () => {
    // The SKU request carries no detail at all.
    expect(checkout).toContain("window.dispatchEvent(new CustomEvent(SKU_REQUEST));");
    expect(count(checkout, /new CustomEvent\(/)).toBe(1);
    expect(checkout).not.toMatch(/postMessage|executeScript|world:\s*"MAIN"/);
    expect(pageReader).toContain('const SKU_REQUEST = "dropshiphub:read-skus";');
    const checkoutScript = manifest.content_scripts.find((entry: { js: string[] }) => entry.js.includes("checkout.js"));
    expect(checkoutScript.js).toEqual(["checkout-core.js", "checkout.js"]);
    expect(checkoutScript.world).toBeUndefined();
  });

  it("puts no address field in a URL it builds", () => {
    const builder = core.slice(core.indexOf("function buildConfirmUrl("), core.indexOf("function readConfirmUrl("));
    expect(builder).not.toMatch(/\baddress\b|firstName|lastName|phone|\bzip\b|\.city\b|\.province/);
    expect(builder).toContain('["provinceCode", ""], ["cityCode", ""]');
  });
});

describe("manifest", () => {
  it("adds the background worker without new permissions", () => {
    expect(manifest.background).toEqual({ service_worker: "background.js" });
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toEqual(["https://*.aliexpress.com/*", "https://*.aliexpress.us/*", "https://cjdropshipping.com/*", "https://*.cjdropshipping.com/*"]);
    expect(background.startsWith('/* global chrome, importScripts, DropshipHubCheckout */')).toBe(true);
    expect(background).toContain('importScripts("checkout-core.js");');
  });
});
