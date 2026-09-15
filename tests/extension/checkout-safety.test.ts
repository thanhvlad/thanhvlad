/**
 * The checkout assist's safety rules, checked against the files the extension
 * ships. The click classifier and the save verification are tested in
 * checkout-core.test.ts; these make sure nothing in the content scripts goes
 * around them, and that customer data has no path to the console, a URL,
 * persistent storage or the page.
 *
 * Two rules from the owner, not negotiable:
 * A. The extension never clicks Pay now / Place order, never touches payment
 *    methods, coupons, the quantity stepper, the address list's edit and
 *    delete icons, radios, or the "Set as default" switch.
 * B. Save on the add-new-address form may be clicked, but only from
 *    saveAddressForm, after core.saveButtonRefusal has read every box back.
 */
import { describe, expect, it } from "vitest";
import { extensionFile } from "./load-core";

const checkout = extensionFile("checkout.js");
const background = extensionFile("background.js");
const core = extensionFile("checkout-core.js");
const orders = extensionFile("orders.js");
const bridge = extensionFile("app-bridge.js");
const pageReader = extensionFile("page-reader.js");
const popup = extensionFile("popup.js");
const manifest = JSON.parse(extensionFile("manifest.json"));

/**
 * A function's source, from its declaration to the closing brace at its own
 * indent: two spaces inside a wrapping IIFE, none in background.js.
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

/** The code without its comments, for rules about what a script names. */
function code(source: string): string {
  return source
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Every argument handed to guardedClick, so the forbidden controls can be checked by name. */
function guardedClickArguments(source: string): string[] {
  return [...source.matchAll(/guardedClick\(([^;]*?)\);/g)].map((m) => m[1]);
}

describe("rule A: clicks go through the guard, and the forbidden controls are never clicked", () => {
  it("has exactly two programmatic clicks: guardedClick after the classifier, and saveAddressForm after the verification", () => {
    const guard = functionSource(checkout, "guardedClick");
    const save = functionSource(checkout, "saveAddressForm");
    expect(count(checkout, /\.click\(/)).toBe(2);
    expect(count(guard, /\.click\(/)).toBe(1);
    expect(count(save, /\.click\(/)).toBe(1);
    expect(count(checkout, /new MouseEvent\(/)).toBe(2);
    expect(count(guard, /new MouseEvent\(/)).toBe(1);
    expect(count(save, /new MouseEvent\(/)).toBe(1);
    expect(guard.indexOf("core.clickRefusal(")).toBeGreaterThan(-1);
    expect(guard.indexOf("core.clickRefusal(")).toBeLessThan(guard.indexOf("dispatchEvent("));
    expect(guard.indexOf("if (refusal) return refusal;")).toBeLessThan(guard.indexOf(".click("));
    // No other file clicks at all.
    for (const source of [core, background, orders, bridge]) expect(source).not.toMatch(/\.click\(|new MouseEvent\(/);
  });

  it("judges every control around the clicked element that the click would activate", () => {
    const describer = functionSource(checkout, "describeForGuard");
    const guard = functionSource(checkout, "guardedClick");
    expect(guard).toContain("core.clickRefusal(describeForGuard(element))");
    expect(describer).toMatch(/for \(let node = element\.parentElement; node; node = node\.parentElement\)/);
    expect(describer).toContain("node.matches(ACTIVATORS)");
    for (const selector of ["button", "input", "label", "summary", "a[href]", '[role="button"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]', "[aria-checked]"]) {
      expect(checkout).toMatch(new RegExp(`const ACTIVATORS =\\s*'[^']*${selector.replace(/[[\]()]/g, "\\$&")}`));
    }
    expect(functionSource(checkout, "describeElement")).toMatch(/element instanceof HTMLLabelElement && element\.control/);
    expect(core).toMatch(/for \(const activator of Array\.isArray\(d\.activators\)/);
  });

  it("never hands the guard Pay now, the default switch, a radio, an edit or delete icon, a payment or quantity control", () => {
    const args = guardedClickArguments(checkout);
    expect(args.length).toBeGreaterThanOrEqual(10);
    for (const arg of args) expect(arg, arg).not.toMatch(/save|confirm|pay|place|switch|radio|edit|delete|quantity|coupon|promo|number/i);
    // The forbidden controls are also refused by the descriptor, wherever a selector drifts to.
    expect(checkout).toMatch(/const FORBIDDEN_INSIDE =\s*'[^']*button\.place-order-primary-btn[^']*\.pl-order-toal-container__btn-box[^']*input\[type="radio"\][^']*\.mt-switch[^']*\.ae-address-item-edit-btn[^']*\.ae-address-item-delete-btn[^']*\.comet-input-number/);
    expect(core).toMatch(/place-order-primary-btn/);
    expect(core).toMatch(/const ADDRESS_LIST_CLASS = \/\^\(mt-switch\|switcher\|ae-address-item-\(edit\|delete\)-btn\|comet-radio/);
    expect(core).toMatch(/const QUANTITY_OR_COUPON_CLASS = \/input-number\|coupon\|promo\/i;/);
    expect(core).toMatch(/const PAYMENT_CLASS = /);
  });

  it("reads the default switch and never clicks or sets it", () => {
    // ".mt-switch" appears twice: in the forbidden list and in the read-only lookup.
    expect(count(checkout, /mt-switch/)).toBe(2);
    const reader = functionSource(checkout, "cometSwitch");
    expect(reader).toContain('querySelector(".mt-switch")');
    expect(functionSource(checkout, "cometSwitchState")).not.toMatch(/click|dispatchEvent|classList\.(add|remove|toggle)/);
    const assignments = checkout.match(/\w+\.checked\s*=(?!=)[^;]*/g) ?? [];
    expect(assignments.length).toBeGreaterThan(0);
    // Only the panel's own "I have paid" box, created by this script.
    for (const line of assignments) expect(line).toBe("paid.checked = true");
  });

  it("only observes the merchant's click on Pay now: never prevents, delays or makes it", () => {
    const observer = functionSource(checkout, "observePayClick");
    expect(observer).toContain('event.target.closest("button.place-order-primary-btn")');
    expect(observer).toContain("if (!event.isTrusted");
    expect(observer).toMatch(/document\.addEventListener\(\s*"click",[\s\S]*?true,\s*\);/);
    for (const source of [checkout, orders, bridge, core, background]) {
      expect(source).not.toMatch(/preventDefault|stopPropagation|stopImmediatePropagation|returnValue\s*=/);
    }
    // "place-order-primary-btn" is only ever read: in the forbidden list, the observer, and nowhere as a click target.
    expect(count(checkout, /place-order-primary-btn/)).toBe(2);
  });

  it("never submits a form, presses a key or dispatches pointer events elsewhere", () => {
    for (const source of [checkout, core, background, orders, bridge]) {
      expect(source).not.toMatch(/\.submit\(|requestSubmit|KeyboardEvent|PointerEvent|TouchEvent|new Event\("submit"/);
    }
  });

  it("dispatches only input and change events on the address form's inputs, from one function, never into the cascade modal", () => {
    const setter = functionSource(checkout, "setInputValue");
    expect(setter).toContain('input.closest(".deliver-address-form")');
    expect(setter).toContain("NOT_TEXT.has(");
    expect(count(checkout, /new Event\(/)).toBe(2);
    expect(count(setter, /new Event\("input"/)).toBe(1);
    expect(count(setter, /new Event\("change"/)).toBe(1);
    // The modal's search box hides the list while it has text; it is never typed into.
    const cascade = functionSource(checkout, "chooseInCascade");
    expect(cascade).not.toMatch(/setInputValue\(|\.value\s*=/);
    expect(cascade).toContain('querySelector(".drawer-cascade-steps")');
    expect(cascade).toContain("core.chooseCascadeOption(");
    expect(cascade).toContain("core.chooseCascadeCity(");
    expect(functionSource(checkout, "closeCascade")).toContain("span.mt-icon-close");
  });
});

describe("rule B: Save on the add-address form only through the verified path", () => {
  it("clicks Save only after core.saveButtonRefusal read the whole form back, and reports on refusal", () => {
    const save = functionSource(checkout, "saveAddressForm");
    const verify = save.indexOf("core.saveButtonRefusal(snapshot)");
    expect(verify).toBeGreaterThan(-1);
    expect(save.indexOf("if (refusal) {")).toBeGreaterThan(verify);
    expect(save.indexOf("if (refusal) {")).toBeLessThan(save.indexOf(".click("));
    expect(save.slice(save.indexOf("if (refusal) {"), save.indexOf(".click("))).toMatch(/return outcome\("partial"/);
    // The click waits for the drawer to close and the page's block to show the customer.
    expect(save.indexOf(".click(")).toBeLessThan(save.indexOf("core.addressBlockShows(block.textContent, values)"));
    expect(save).toContain("Address set. Check the total, then press Pay now on AliExpress yourself.");
    // Only the measured Save (comet) and Confirm (Fusion) controls are snapshotted.
    expect(functionSource(checkout, "cometSaveSnapshot")).toContain('querySelector("button.form-button-confirm")');
    expect(functionSource(checkout, "fusionConfirmButton")).toMatch(/\/\^\(confirm\|xác nhận\)\$\/i/);
    expect(count(checkout, /return saveAddressForm\(\{/)).toBe(2);
  });

  it("verifies, in core, the boxes, State, City, the country, the switch and the button itself", () => {
    const verify = core.slice(core.indexOf("function saveButtonRefusal("), core.indexOf("// Money"));
    for (const check of ["foreignFormValues(s.boxes", "mismatchedFields(intended, s.actual)", "s.country?.shown", "s.state?.shown", "s.city?.shown", 's.defaultSwitch !== "off"', "form-button-confirm", "PAYMENT_CLASS.test(c)"]) {
      expect(verify, check).toContain(check);
    }
  });

  it("reads the form's values and the switch before it types or chooses anything, on both designs", () => {
    const comet = functionSource(checkout, "fillCometForm");
    const cometRefusals = [...comet.matchAll(/if \(cometRefusesFill\(form, values, status, (true|false)\)\) return/g)];
    expect(cometRefusals.map((m) => m[1])).toEqual(["false", "true"]);
    expect(comet.indexOf("cometRefusesFill(")).toBeLessThan(comet.indexOf("cometEnterManually("));
    const lastComet = cometRefusals[1].index ?? -1;
    for (const step of ["setInputValue(", "chooseInCascade("]) expect(comet.indexOf(step), step).toBeGreaterThan(lastComet);
    expect(comet.indexOf("core.cometFormStructure(")).toBeLessThan(lastComet);
    expect(comet.indexOf("core.matchOption([country], countryCandidates)")).toBeLessThan(comet.indexOf("cometEnterManually("));
    const cometGuard = functionSource(checkout, "cometRefusesFill");
    expect(cometGuard).toContain("core.foreignFormValues(");
    expect(cometGuard).toMatch(/if \(state === "on"\) \{[\s\S]*return true;/);
    expect(cometGuard).toMatch(/if \(state === "missing" && requireSwitch\) \{[\s\S]*return true;/);

    const fusion = functionSource(checkout, "fillFusionForm");
    const refusals = [...fusion.matchAll(/if \(formRefusesFill\(form, values, status, (true|false)\)\) return/g)];
    expect(refusals.map((m) => m[1])).toEqual(["false", "true"]);
    expect(fusion.indexOf("formRefusesFill(")).toBeLessThan(fusion.indexOf("enterManuallyIfNeeded("));
    const lastCheck = refusals[1].index ?? -1;
    for (const step of ["stateSelect, stateCandidates[0]", "chooseInSelect(citySelect", "setInputValue("]) {
      expect(fusion.indexOf(step), step).toBeGreaterThan(lastCheck);
    }
    const guard = functionSource(checkout, "formRefusesFill");
    expect(guard).toContain("core.foreignFormValues(");
    expect(guard).toMatch(/if \(box === "ticked"\) \{[\s\S]*return true;/);
    expect(guard).toMatch(/if \(box === "missing" && requireBox\) \{[\s\S]*return true;/);
  });

  it("hands the guard the real controls: the comet Enter manually div and the Fusion control around the span", () => {
    expect(functionSource(checkout, "cometEnterManually")).toContain('querySelectorAll("div.text-button-container")');
    expect(functionSource(checkout, "enterManuallyIfNeeded")).toContain(`guardedClick(link.closest("button, a, [role='button']") ?? link)`);
    const open = functionSource(checkout, "openFormIfNeeded");
    // The measured "Change" control is the <a> inside the span; a selector
    // list would return the span, which precedes its own child in tree order.
    expect(open).toContain('document.querySelector("span.pl-address-item__arrrow a") ?? document.querySelector("span.pl-address-item__arrrow")');
    expect(open).toContain('drawer.querySelector("button.add-address")');
    // The switch and Save are looked for in the whole drawer, the widest measured container.
    expect(functionSource(checkout, "cometScope")).toContain('form.closest(".comet-drawer") ?? form.closest(".deliver-address-wrap")');
  });

  it('says "left unticked" only after reading the box on the Fusion by-hand path', () => {
    const finish = functionSource(checkout, "finishFusionByHand");
    expect(count(checkout, /left unticked/)).toBe(1);
    expect(finish.indexOf("readDefaultBox(")).toBeGreaterThan(-1);
    expect(finish.indexOf("readDefaultBox(")).toBeLessThan(finish.indexOf("left unticked"));
    expect(finish).toMatch(/if \(box === "ticked"\)/);
  });

  it("stops the fill once the checkout is cancelled or the page moves on, right up to the Save click", () => {
    expect(count(functionSource(checkout, "fillFusionForm"), /if \(!\(await fillMayContinue\(job, status\)\)\) return/)).toBeGreaterThanOrEqual(5);
    expect(count(functionSource(checkout, "fillCometForm"), /if \(!\(await fillMayContinue\(job, status\)\)\) return/)).toBeGreaterThanOrEqual(2);
    expect(functionSource(checkout, "chooseInCascade")).toContain("if (!(await fillMayContinue(job, status)))");
    // A checkout cancelled during the read-back sleep must not be committed:
    // the check is the first thing saveAddressForm does, before the snapshot,
    // and nothing waits between the snapshot and the click.
    const save = functionSource(checkout, "saveAddressForm");
    const check = save.indexOf('if (!(await fillMayContinue(job, status))) return outcome("partial"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(save.indexOf("cometSaveSnapshot("));
    expect(save.slice(save.indexOf("const snapshot ="), save.indexOf(".click("))).not.toMatch(/await/);
    expect(count(checkout, /return saveAddressForm\(\{ design: "(comet|fusion)", form: current, job, /)).toBe(2);
    const may = functionSource(checkout, "fillMayContinue");
    expect(may).toContain('ask({ type: "checkout:get" })');
    expect(may).toContain("current.purchaseOrderId !== job.purchaseOrderId");
  });

  it("fills and quotes only the checkout page of the item itself", () => {
    // A later navigation in the tab (Buy now on another product) must not get the customer's address or post its total.
    const fill = functionSource(checkout, "fillAddress");
    expect(fill.indexOf("if (!pageMatchesItem(job)) {")).toBeGreaterThan(-1);
    expect(fill.indexOf("if (!pageMatchesItem(job)) {")).toBeLessThan(fill.indexOf("openFormIfNeeded("));
    const auto = functionSource(checkout, "autoFill");
    expect(auto.indexOf("if (!pageMatchesItem(job)) {")).toBeLessThan(auto.indexOf("await runFill("));
    expect(functionSource(checkout, "pageMatchesItem")).toContain("core.confirmUrlMismatches(location.href, job.items[job.itemIndex], job.address.countryCode).length === 0");
    const cost = functionSource(checkout, "costBlock");
    expect(cost).toContain("if (verdict.page && gate.pageMatches() && gate.addressSet()) {");
    expect(functionSource(checkout, "renderConfirm")).toContain("pageMatches: () => pageMatchesItem(job)");
  });
});

describe("the automatic fill", () => {
  it("runs from the page's readiness or the button only, and records its outcome in the job", () => {
    expect(count(checkout, /fillAddress\(/)).toBe(2);
    const run = functionSource(checkout, "runFill");
    expect(run).toContain("await fillAddress(job, values, status)");
    expect(run).toContain('ask({ type: "checkout:fill-result", result: outcome.result, reason: outcome.reason })');
    expect(count(checkout, /(await|=>) runFill\(job, values, /)).toBe(2);
    const auto = functionSource(checkout, "autoFill");
    expect(auto).toContain('document.querySelector(".pl-address-item-container")');
    expect(auto.indexOf("core.addressBlockShows(block.textContent, values)")).toBeLessThan(auto.indexOf("await runFill("));
    expect(auto.indexOf("core.shouldAutoFill(job, shown)")).toBeLessThan(auto.indexOf("await runFill("));
    // Every panel button ignores clicks that are not the merchant's own.
    const helper = functionSource(checkout, "button");
    expect(helper).toContain("if (!event.isTrusted) return;");
    expect(helper.indexOf("if (!event.isTrusted) return;")).toBeLessThan(helper.indexOf("onClick(event)"));
    // The worker keeps the outcome per item and clears it when the item changes.
    expect(background).toMatch(/case "checkout:fill-result": \{[\s\S]*?fill: \{ itemIndex: job\.itemIndex, result/);
    expect(background).toMatch(/case "checkout:next": \{[\s\S]*?fill: null/);
  });

  it("sends the page's total only once the customer's address is set, and again when it changes", () => {
    const cost = functionSource(checkout, "costBlock");
    // Before the address is set the total carries the merchant's default address's tax and shipping.
    expect(cost.indexOf("gate.addressSet()")).toBeLessThan(cost.indexOf("sendQuote("));
    expect(cost).toContain("if (key && key !== lastQuoteKey) {");
    expect(functionSource(checkout, "renderConfirm")).toContain("core.addressBlockShows(block.textContent, values)");
    // The fill's "set" re-reads the total for a while.
    const run = functionSource(checkout, "runFill");
    expect(run).toContain('if (outcome.result === "set") afterSet?.();');
    expect(functionSource(checkout, "autoFill")).toContain("afterSet?.();");
    // The worker no longer locks the item after one send: a different total is posted, the same one is not.
    expect(background).toMatch(/case "checkout:quote": \{[\s\S]*?if \(previous\?\.sent && core\.sameQuote\(previous, quote\)\) return \{ ok: true, alreadySent: true \};/);
  });
});

describe("customer data stays inside the extension", () => {
  it("is never logged", () => {
    for (const source of [checkout, core, background, orders, bridge, popup]) expect(source).not.toMatch(/console\./);
  });

  it("builds the panels with textContent in closed shadow roots", () => {
    expect(checkout).toContain('attachShadow({ mode: "closed" })');
    expect(orders).toContain('attachShadow({ mode: "closed" })');
    for (const source of [checkout, core, orders, bridge]) expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("is kept only in session storage, by the background worker", () => {
    for (const source of [checkout, orders, bridge]) expect(source).not.toMatch(/chrome\.storage|localStorage|sessionStorage|indexedDB/);
    expect(core).not.toMatch(/chrome\.[a-z]+\.|localStorage|sessionStorage|indexedDB/);
    expect(background).not.toMatch(/storage\.local|localStorage|indexedDB|setAccessLevel/);
    expect(background).toMatch(/chrome\.storage\.session\.set\(/);
    // The only synced read is the app URL and token the options page stores.
    expect(background.match(/storage\.sync\.[a-z]+\([^)]*\)/g)).toEqual(['storage.sync.get(["appUrl", "token"])']);
  });

  it("is sent only to the app's own extension endpoints, through one fetch", () => {
    for (const source of [checkout, core, orders, bridge]) expect(source).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
    expect(count(background, /fetch\(/)).toBe(1);
    expect(functionSource(background, "callApp", "")).toMatch(/fetch\(`\$\{settings\.base\}\$\{path\}`/);
    const paths = [...background.matchAll(/callApp\((`[^`]*`|"[^"]*")/g)].map((m) => m[1]);
    /* eslint-disable no-template-curly-in-string -- the worker's own template literals, matched as source text */
    expect(paths.sort()).toEqual([
      '"/api/extension/orders"',
      '"/api/extension/orders/sync"',
      '"/api/extension/orders/sync-tracking"',
      "`/api/extension/orders/${encodeURIComponent(job.purchaseOrderId)}/placed`",
      "`/api/extension/orders/${encodeURIComponent(job.purchaseOrderId)}/quote`",
    ]);
    /* eslint-enable no-template-curly-in-string */
  });

  it("is cleared when a checkout finishes, is cancelled, is recorded by the orders page, or its tab closes", () => {
    const finish = functionSource(background, "finish", "");
    expect(finish).toContain("const ended = !answer.ok && (answer.httpStatus === 404 || answer.httpStatus === 409);");
    expect(finish).toContain("if (answer.ok || ended) await dropJob(job.tabId);");
    expect(background).toMatch(/case "checkout:cancel": \{\s*await dropJob\(tabId\);/);
    expect(background).toMatch(/chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => \{\s*dropJob\(tabId\)/);
    const drop = functionSource(background, "dropRecordedJobs", "");
    expect(drop).toContain('["recorded", "already", "advanced"].includes(entry.result)');
    expect(drop).toContain("await sweep(entry.purchaseOrderId)");
    expect(background).toMatch(/sync:orders"\) \{[\s\S]*?await dropRecordedJobs\(results\)/);
    // A multi-item purchase order's "partial" result is noted in the job, never swept: the remaining items are still to buy.
    expect(drop).not.toMatch(/partial/);
    const attach = functionSource(background, "attachPartialResults", "");
    expect(attach).toContain('entry?.result === "partial"');
    expect(attach).toContain("core.attachOrderToJob(current, entry)");
    // The last item's number finishes the purchase order through the same placed path as the panel's Send, paid only when every number reads as paid.
    expect(attach).toContain("if (!core.isLastItem(current)) continue;");
    expect(attach).toContain("const answer = await finish(current, paid);");
    expect(attach).toContain("entry.paid === true");
    expect(background).toMatch(/sync:orders"\) \{[\s\S]*?const results = await attachPartialResults\([\s\S]*?await dropRecordedJobs\(results\)/);
  });

  it("is cleared when the popup records the order, and when it expires without being read", () => {
    expect(functionSource(background, "forgetCheckout", "")).toContain("await sweep(purchaseOrderId);");
    // Only the extension's own pages may drop a job by purchase order, or register the bridge.
    expect(functionSource(background, "route", "")).toMatch(/"bridge:register"\) \{\s*if \(!fromExtensionPage\(sender\)\) return/);
    expect(popup).toMatch(/if \(\(status === 200 && answer\.ok\) \|\| status === 404 \|\| status === 409\) forgetCheckout\(order\.id\);/);
    expect(background).toMatch(/chrome\.runtime\.onMessage\.addListener\([\s\S]*?sweep\(\)\s*\.catch\(\(\) => undefined\)\s*\.then\(\(\) => route\(message, sender\)\)/);
    expect(background).toMatch(/chrome\.tabs\.onUpdated\.addListener\([\s\S]*?sweep\(\)/);
    expect(background).toMatch(/chrome\.tabs\.onReplaced\.addListener/);
  });

  it("never crosses into the page's MAIN world", () => {
    expect(checkout).toContain("window.dispatchEvent(new CustomEvent(SKU_REQUEST));");
    expect(count(checkout, /new CustomEvent\(/)).toBe(1);
    for (const source of [checkout, orders]) expect(source).not.toMatch(/postMessage|executeScript|world:\s*"MAIN"/);
    expect(pageReader).toContain('const SKU_REQUEST = "dropshiphub:read-skus";');
    const checkoutScript = manifest.content_scripts.find((entry: { js: string[] }) => entry.js.includes("checkout.js"));
    expect(checkoutScript.js).toEqual(["checkout-core.js", "checkout.js"]);
    expect(checkoutScript.world).toBeUndefined();
  });

  it("puts no address field in a URL it builds", () => {
    const builder = core.slice(core.indexOf("function buildConfirmUrl("), core.indexOf("function readConfirmUrl("));
    expect(builder).not.toMatch(/\baddress\b|firstName|lastName|phone|\bzip\b|\.city\b|\.province/);
    expect(builder).toContain('["provinceCode", ""], ["cityCode", ""]');
    expect(functionSource(background, "startCheckoutById", "")).toContain('callApp("/api/extension/orders")');
  });
});

describe("the orders-page sync reads order ids, product ids, SKU text, status, totals, dates and tracking only", () => {
  it("reads nothing of the customer from the list, the detail page or the tracking page", () => {
    // The detail page's .order-detail-info and the tracking page's node texts carry the address; neither is read.
    expect(code(orders)).not.toMatch(/order-detail-info\b|nodeDesc|nodeTitle|consignee|address|phone|receiver/i);
    expect(orders).toContain('querySelectorAll(".order-item")');
    expect(orders).toContain('querySelector(\'a[href*="/p/order/detail.html"]\')');
    expect(orders).toContain('querySelectorAll(".order-detail-order-info .info-row")');
    expect(orders).toContain('querySelector(".order-status")');
    expect(orders).toContain('[class*="logistic-info-v2--carrierTitle"]');
    expect(orders).toContain('[class*="logistic-info-v2--mailNoValue"]');
    for (const parser of ["core.parseOrderCard(", "core.parseOrderDetail(", "core.parseTrackingPage("]) expect(orders).toContain(parser);
    // Only these two messages leave the page, and the worker forwards only well-formed values.
    expect(orders.match(/ask\(\{ type: "([^"]+)"/g)).toEqual(['ask({ type: "sync:orders"', 'ask({ type: "sync:tracking"']);
    // The paying hints carry a purchase order id and a time, read from the jobs in stage "paying", nothing of the customer.
    expect(background).toMatch(/sync:orders"\) \{\s*const body = core\.ordersSyncBody\(message\.orders, await payingHints\(\)\)/);
    const hints = functionSource(background, "payingHints", "");
    expect(hints).toContain('job?.stage === "paying"');
    expect(hints).toContain("({ purchaseOrderId: job.purchaseOrderId, payingAt: job.payingAt })");
    expect(hints).not.toMatch(/address|items|phone/);
    expect(background).toMatch(/sync:tracking"\) \{\s*const tracking = core\.parseTrackingPage\(/);
    // The detail page's product links are not read: its item block is unmeasured and its recommendation strips link products too.
    const detail = functionSource(orders, "readDetail");
    expect(detail).not.toMatch(/item|productHrefs|hrefs\(/);
    expect(orders).toContain("hrefs(card, 'a[href*=\"/item/\"]')");
  });

  it("is registered for the order and tracking pages only, with the core first", () => {
    const script = manifest.content_scripts.find((entry: { js: string[] }) => entry.js.includes("orders.js"));
    expect(script.js).toEqual(["checkout-core.js", "orders.js"]);
    expect(script.matches).toEqual(["https://*.aliexpress.com/p/order/*", "https://*.aliexpress.us/p/order/*", "https://*.aliexpress.com/p/tracking/*", "https://*.aliexpress.us/p/tracking/*"]);
    expect(script.world).toBeUndefined();
  });
});

describe("the app-page bridge", () => {
  it("is registered for the app's origin only once that permission is granted, never statically", () => {
    expect(manifest.content_scripts.some((entry: { js: string[] }) => entry.js.includes("app-bridge.js"))).toBe(false);
    const register = functionSource(background, "registerAppBridgeNow", "");
    expect(register.indexOf("chrome.permissions.contains({ origins })")).toBeLessThan(register.indexOf("chrome.scripting.registerContentScripts("));
    expect(register).toContain("if (!granted) return false;");
    expect(register).toContain('js: ["app-bridge.js"], matches: origins');
    // The start-up, onInstalled and onStartup calls are serialized, so two unregister/register pairs cannot race.
    expect(functionSource(background, "registerAppBridge", "")).toContain("bridgeChain = bridgeChain.then(registerAppBridgeNow, registerAppBridgeNow)");
    // Nothing calls the inner function directly: its only "()" is its declaration.
    expect(background.match(/registerAppBridgeNow\(\)/g)).toEqual(["registerAppBridgeNow()"]);
    expect(background).toMatch(/async function registerAppBridgeNow\(\)/);
    expect(background).toMatch(/chrome\.permissions\.onAdded\.addListener/);
    expect(popup).toContain('chrome.runtime.sendMessage({ type: "bridge:register" })');
  });

  it("relays only a purchase order id, from the page's own window and origin, and accepts it only from the app origin", () => {
    expect(bridge).toContain("if (event.source !== window || event.origin !== location.origin) return;");
    expect(bridge).toMatch(/window\.postMessage\(\{ source: EXTENSION, version, \.\.\.payload \}, location\.origin\)/);
    expect(bridge).toContain('chrome.runtime.sendMessage({ type: "checkout:start-by-id", purchaseOrderId })');
    expect(code(bridge)).not.toMatch(/address|token|fetch\(|chrome\.storage|chrome\.tabs/);
    expect(functionSource(background, "route", "")).toMatch(/"checkout:start-by-id"\) \{\s*if \(!\(await fromAppPage\(sender\)\)\) return \{ ok: false/);
    const from = functionSource(background, "fromAppPage", "");
    expect(from).toContain("origin === settings.base");
    expect(functionSource(background, "startCheckoutById", "")).toContain("core.isPurchaseOrderId(purchaseOrderId)");
  });
});

describe("manifest", () => {
  it("is version 1.6.0 with the background worker and no new permissions", () => {
    expect(manifest.version).toBe("1.6.0");
    expect(manifest.background).toEqual({ service_worker: "background.js" });
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toEqual(["https://*.aliexpress.com/*", "https://*.aliexpress.us/*", "https://cjdropshipping.com/*", "https://*.cjdropshipping.com/*"]);
    expect(background.startsWith("/* global chrome, importScripts, DropshipHubCheckout */")).toBe(true);
    expect(background).toContain('importScripts("checkout-core.js");');
  });
});
