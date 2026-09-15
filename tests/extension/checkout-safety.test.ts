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
    expect(functionSource(background, "finish", "")).toContain("if (answer.ok) await dropJob(job.tabId);");
    expect(background).toMatch(/case "checkout:cancel": \{\s*await dropJob\(tabId\);/);
    expect(background).toMatch(/chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => \{\s*dropJob\(tabId\)/);
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
