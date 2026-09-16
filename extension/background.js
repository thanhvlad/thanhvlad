/* global chrome, importScripts, DropshipHubCheckout */

/**
 * The checkout assist's owner: one checkout job per tab, and the only part of
 * the extension that talks to the app.
 *
 * A Manifest V3 service worker is stopped after about thirty seconds idle,
 * and a merchant spends minutes on an AliExpress checkout, so nothing about a
 * job may live only in this worker's memory: every read goes back to
 * chrome.storage.session. That area is also the only place a job may be kept.
 * It holds the customer's name, phone and address; session storage is kept in
 * memory, never written to disk, emptied when the browser closes, and by
 * default readable only by the extension's own pages and this worker, not by
 * content scripts. Content scripts ask for their own tab's job by message.
 *
 * A job is removed when its purchase order is recorded (here, by the orders
 * page's sync, or with the popup's "Mark as placed"), when the app says it is
 * gone or recorded with other numbers, when the merchant cancels, when its
 * tab closes, and when it is older than a few hours.
 */

importScripts("checkout-core.js");

const core = DropshipHubCheckout;
const JOB_PREFIX = "checkout:";
const FETCH_TIMEOUT_MS = 20000;
const BRIDGE_SCRIPT_ID = "dropshiphub-app-bridge";
const ADMIN_BRIDGE_SCRIPT_ID = "dropshiphub-admin-bridge";
/** The Shopify admin, which embeds the app as a cross-origin iframe. */
const ADMIN_ORIGIN = "https://admin.shopify.com";
const ADMIN_MATCH = `${ADMIN_ORIGIN}/*`;

function jobKey(tabId) {
  return `${JOB_PREFIX}${tabId}`;
}

async function readJob(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const key = jobKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored) return null;
  if (core.isJobExpired(stored, Date.now())) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return stored;
}

async function writeJob(job) {
  await chrome.storage.session.set({ [jobKey(job.tabId)]: job });
}

async function dropJob(tabId) {
  await chrome.storage.session.remove(jobKey(tabId));
}

/** Expired jobs and, when given, every other job for the same purchase order. */
async function sweep(purchaseOrderId) {
  const everything = await chrome.storage.session.get(null);
  const now = Date.now();
  const stale = Object.entries(everything)
    .filter(([key, job]) => key.startsWith(JOB_PREFIX) && (core.isJobExpired(job, now) || (purchaseOrderId && job?.purchaseOrderId === purchaseOrderId)))
    .map(([key]) => key);
  if (stale.length) await chrome.storage.session.remove(stale);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  dropJob(tabId).catch(() => undefined);
});

// A prerendered or discarded tab can be swapped for a new tab id. The job
// follows it; otherwise it sat under the old id, unreachable, with the address
// in it, until it expired.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  (async () => {
    const job = await readJob(removedTabId);
    if (!job) return;
    await writeJob({ ...job, tabId: addedTabId });
    await dropJob(removedTabId);
  })().catch(() => undefined);
});

// The four-hour expiry used to run only when that tab's job was read, or once
// when the worker started. A job whose tab stayed open on another site was
// never read, and kept the customer's address in memory past its expiry. So
// expired jobs are also swept on every message and whenever a tab finishes
// loading; alarms would need a new permission.
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.status === "complete") sweep().catch(() => undefined);
});
sweep().catch(() => undefined);

// ---------------------------------------------------------------------------
// The app's API
// ---------------------------------------------------------------------------

function appOrigin(raw) {
  // The same rule as the popup: the options field takes an origin, and a value
  // carrying a path would double the endpoint path in the request url.
  const trimmed = String(raw ?? "").trim();
  const value = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(value);
    // A mistyped http:// app URL would send the Bearer token, and the order
    // numbers with it, in clear text. Plain http is only for a local app.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The app origin and token from the options page: the only synced values this worker reads. */
async function appSettings() {
  const { appUrl, token } = await chrome.storage.sync.get(["appUrl", "token"]);
  const base = appUrl ? appOrigin(appUrl) : null;
  if (!base || !token) return { error: "Set the app URL (https://) and token in the extension options." };
  return { base, token };
}

/**
 * The one call to the app. Every endpoint this worker uses is under
 * /api/extension/, on the configured origin, with the stored token; nothing
 * else is ever fetched. Answers { ok, status, answer } or { ok: false, error }
 * for a call that never got an answer.
 */
async function callApp(path, init = {}) {
  const settings = await appSettings();
  if (settings.error) return { ok: false, status: 0, answer: {}, error: `${settings.error} Then try again.` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${settings.base}${path}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: controller.signal,
    });
    const answer = await response.json().catch(() => ({}));
    return { ok: response.status === 200 && answer.ok === true, status: response.status, answer };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "the app did not answer in time" : "the app could not be reached";
    return { ok: false, status: 0, answer: {}, error: `${reason}. Check the app URL in the extension options and try again.` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Records the purchase order as placed with every AliExpress order number the
 * job collected. The endpoint moves a purchase order out of "waiting" once and
 * answers the same ids again with alreadyRecorded, so it cannot take one item's
 * number now and the next item's later: the ids are collected per item in the
 * job and sent together with the last one. A lost response is then safe to
 * retry, because the same ids are sent again.
 */
async function postPlaced(job, paid) {
  const ids = core.jobOrderIds(job);
  if (ids.length === 0) return { ok: false, error: "No AliExpress order number has been recorded yet." };
  if (ids.length > 20) return { ok: false, error: "A purchase order can carry at most 20 AliExpress order numbers." };
  const call = await callApp(`/api/extension/orders/${encodeURIComponent(job.purchaseOrderId)}/placed`, { method: "POST", body: { externalOrderIds: ids, paid: paid === true } });
  if (call.error) return { ok: false, error: `Not saved: ${call.error}` };
  if (call.ok) return { ok: true, alreadyRecorded: call.answer.alreadyRecorded === true, status: call.answer.status, externalOrderIds: ids };
  return { ok: false, httpStatus: call.status, error: core.explainRefusal(call.status, call.answer) };
}

/**
 * Sends the confirm page's real total for the purchase order: the sum of the
 * quotes of every item quoted so far, since each item is its own AliExpress
 * checkout. Sent whenever an item's readable total differs from the one on
 * record; a lost answer is retried by the next page load, and the endpoint
 * answers the same total again with `unchanged`.
 */
async function postQuote(job) {
  const body = core.quoteBody(core.sumQuotes(job.quotes));
  if (!body) return { ok: false, error: "The page's total could not be read." };
  const call = await callApp(`/api/extension/orders/${encodeURIComponent(job.purchaseOrderId)}/quote`, { method: "POST", body });
  if (call.error) return { ok: false, error: call.error };
  if (call.ok) return { ok: true, unchanged: call.answer.unchanged === true };
  return { ok: false, httpStatus: call.status, error: core.explainRefusal(call.status, call.answer) };
}

// ---------------------------------------------------------------------------
// The app page's "Order on AliExpress with the extension" button
//
// app-bridge.js is registered for the app's origin only once the merchant has
// granted that optional host permission (the popup's "Allow access"), and it
// relays the page's request here. The order itself is fetched from the app
// with the token, exactly as the popup does; the page names only the id.
// ---------------------------------------------------------------------------

async function registerAppBridgeNow() {
  await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID, ADMIN_BRIDGE_SCRIPT_ID] }).catch(() => undefined);
  const settings = await appSettings();
  if (settings.error) return false;
  const origins = [`${settings.base}/*`];
  const granted = await chrome.permissions.contains({ origins }).catch(() => false);
  if (!granted) return false;
  // allFrames: the app runs inside the Shopify admin's iframe, and the
  // bridge has to run in that frame, whose URL is the app's origin.
  const scripts = [{ id: BRIDGE_SCRIPT_ID, js: ["app-bridge.js"], matches: origins, runAt: "document_idle", allFrames: true }];
  // Chrome did not run that registration in the app's frame inside the
  // Shopify admin (measured: the button said the extension had no access,
  // while the same bridge answered on the app's origin as a top-level page).
  // The same script runs in the admin's TOP frame as a relay, and only while
  // the merchant has granted that origin too.
  const adminGranted = await chrome.permissions.contains({ origins: [ADMIN_MATCH] }).catch(() => false);
  if (adminGranted) scripts.push({ id: ADMIN_BRIDGE_SCRIPT_ID, js: ["app-bridge.js"], matches: [ADMIN_MATCH], runAt: "document_idle", allFrames: false });
  try {
    await chrome.scripting.registerContentScripts(scripts);
    return true;
  } catch {
    return false;
  }
}

/**
 * One registration at a time. The worker's start, onInstalled and onStartup
 * all ask for it at once, and two unregister/register pairs racing each other
 * could end with "Duplicate script ID" swallowed and the bridge unregistered.
 */
let bridgeChain = Promise.resolve(false);
function registerAppBridge() {
  bridgeChain = bridgeChain.then(registerAppBridgeNow, registerAppBridgeNow).catch(() => false);
  return bridgeChain;
}

chrome.runtime.onInstalled.addListener(() => {
  registerAppBridge().catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  registerAppBridge().catch(() => undefined);
});
chrome.permissions.onAdded.addListener(() => {
  registerAppBridge().catch(() => undefined);
});
chrome.permissions.onRemoved.addListener(() => {
  registerAppBridge().catch(() => undefined);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.appUrl || changes.token)) registerAppBridge().catch(() => undefined);
});
registerAppBridge().catch(() => undefined);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function fromExtensionPage(sender) {
  return sender.id === chrome.runtime.id && !sender.tab && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

function senderOrigin(sender) {
  try {
    return new URL(sender.url ?? sender.tab?.url ?? "").origin;
  } catch {
    return null;
  }
}

function fromAliExpressTab(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id)) return false;
  try {
    return core.isAliExpressHost(new URL(sender.url ?? sender.tab.url ?? "").hostname);
  } catch {
    return false;
  }
}

/**
 * The app bridge: a content script in a frame whose origin is the configured
 * app origin, or the relay in the Shopify admin's top frame.
 *
 * Embedded in the Shopify admin the app is a cross-origin iframe, and a
 * content script registered for the app's origin does not reach that frame
 * (measured: the very same bridge answered on the app's origin as a
 * top-level page). The relay runs on the admin page instead and names the
 * origin it accepted the page's message from; that origin must be the
 * configured app origin, and the relay itself must be the admin page. Any
 * other sender is refused exactly as before.
 */
async function fromAppPage(sender, message) {
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  const settings = await appSettings();
  if (settings.error) return false;
  const origin = senderOrigin(sender);
  if (origin === null) return false;
  if (origin === settings.base) return true;
  return origin === ADMIN_ORIGIN && String(message?.appOrigin ?? "") === settings.base;
}

/**
 * The checkout's tab. With an opener (the app tab, on the order page's
 * button) Chrome places the new tab next to it, in its window and tab group;
 * Chrome refuses an opener it no longer knows or in another window, and the
 * tab is then opened without one. The popup has no tab to open from.
 */
async function createCheckoutTab(opener) {
  const options = { url: "about:blank", active: true };
  if (opener && Number.isInteger(opener.tabId)) {
    try {
      const tab = await chrome.tabs.create({ ...options, openerTabId: opener.tabId, ...(Number.isInteger(opener.windowId) ? { windowId: opener.windowId } : {}) });
      await groupWithOpener(tab, opener);
      return tab;
    } catch {
      // Fall through: the checkout still opens, just not beside the app tab.
    }
  }
  return chrome.tabs.create(options);
}

/**
 * Puts the checkout tab in the opener's tab group. Chrome did not do it by
 * itself on the measured account even with openerTabId, and the checkout tab
 * was then hard to find beside the app's. Grouping is cosmetic: a group that
 * is gone, or a Chrome without tabGroups, leaves the tab where it is.
 */
async function groupWithOpener(tab, opener) {
  if (!Number.isInteger(tab?.id) || !Number.isInteger(opener?.groupId) || opener.groupId <= -1) return;
  try {
    await chrome.tabs.group({ tabIds: [tab.id], groupId: opener.groupId });
  } catch {
    // The tab is open either way; where it sits is not worth failing for.
  }
}

async function startCheckout(order, opener = null) {
  const built = core.buildJob(order, null, Date.now());
  if (built.error) return { ok: false, error: built.error };
  // Starting the same purchase order again replaces the older job, so two
  // tabs cannot both collect order numbers for it.
  await sweep(built.job.purchaseOrderId);
  // An about:blank tab first, so the job is stored before any AliExpress page
  // in that tab can ask for it; opening the product directly would race the
  // write against the page's content script.
  const tab = await createCheckoutTab(opener);
  const job = { ...built.job, tabId: tab.id };
  await writeJob(job);
  await chrome.tabs.update(tab.id, { url: core.productPageUrl(job.items[0].externalProductId) });
  return { ok: true };
}

/** The app page named a purchase order; the order itself comes from the app with the token. The checkout opens beside that page's tab. */
async function startCheckoutById(purchaseOrderId, opener) {
  if (!core.isPurchaseOrderId(purchaseOrderId)) return { ok: false, error: "No such order." };
  const call = await callApp("/api/extension/orders");
  if (call.error) return { ok: false, error: call.error };
  if (!call.ok) return { ok: false, error: core.explainRefusal(call.status, call.answer).replace(/^Not saved[:.]?\s*/, "") };
  const order = (Array.isArray(call.answer.orders) ? call.answer.orders : []).find((o) => o && o.id === purchaseOrderId);
  if (!order) return { ok: false, error: "This order is not waiting to be placed any more. Reload the page." };
  return startCheckout(order, opener);
}

/** Jobs whose purchase order the orders page has just recorded are dropped, as on a record here. */
async function dropRecordedJobs(results) {
  for (const entry of Array.isArray(results) ? results : []) {
    if (!entry || !["recorded", "already", "advanced"].includes(entry.result) || !core.isPurchaseOrderId(entry.purchaseOrderId)) continue;
    await sweep(entry.purchaseOrderId);
  }
}

/** Every job in stage "paying": its purchase order and when Pay now was pressed, for the app to prefer among several waiting purchase orders. */
async function payingHints() {
  const everything = await chrome.storage.session.get(null);
  return Object.entries(everything)
    .filter(([key, job]) => key.startsWith(JOB_PREFIX) && job?.stage === "paying" && Number.isInteger(job.payingAt))
    .map(([, job]) => ({ purchaseOrderId: job.purchaseOrderId, payingAt: job.payingAt }));
}

/**
 * A `partial` result names a multi-item purchase order whose one item's
 * AliExpress order the page shows. The number goes into that item's slot of
 * the job checking it out (any tab), and the job moves to "recorded" so the
 * merchant goes on to the next item. Once the last item has its number, the
 * numbers are sent together through the placed endpoint, exactly as the
 * panel's Send does, and the page's results say so; a send that fails leaves
 * the job in "recorded" with the numbers, for the panel's Send to retry.
 * Answers the results with those entries replaced.
 */
async function attachPartialResults(results) {
  const list = Array.isArray(results) ? results.slice() : [];
  const partial = list.filter((entry) => entry?.result === "partial" && core.isPurchaseOrderId(entry.purchaseOrderId));
  if (partial.length === 0) return list;
  const everything = await chrome.storage.session.get(null);
  for (const [key, job] of Object.entries(everything)) {
    if (!key.startsWith(JOB_PREFIX)) continue;
    let current = job;
    for (const entry of partial) {
      const next = core.attachOrderToJob(current, entry);
      if (next) current = next;
    }
    if (current === job) continue;
    await writeJob(current);
    if (!core.isLastItem(current)) continue;
    // Paid only when every number on the job reads as paid on this page; one
    // not on the page counts as unpaid, and the next sync advances it.
    const ids = core.jobOrderIds(current);
    const paid = ids.every((id) => partial.some((entry) => entry.orderId === id && entry.purchaseOrderId === current.purchaseOrderId && entry.paid === true));
    const answer = await finish(current, paid);
    if (!answer.ok) continue;
    for (let i = 0; i < list.length; i += 1) {
      const entry = list[i];
      if (entry?.result === "partial" && entry.purchaseOrderId === current.purchaseOrderId) {
        list[i] = { ...entry, result: "recorded", status: answer.status, externalOrderIds: answer.externalOrderIds };
      }
    }
  }
  return list;
}

async function handleTabMessage(message, sender) {
  const tabId = sender.tab.id;
  if (message.type === "sync:orders") {
    const body = core.ordersSyncBody(message.orders, await payingHints());
    if (!body) return { ok: false, error: "No AliExpress orders to sync." };
    const call = await callApp("/api/extension/orders/sync", { method: "POST", body });
    if (call.error) return { ok: false, error: call.error };
    if (!call.ok) return { ok: false, error: core.explainRefusal(call.status, call.answer).replace(/^Not saved[:.]?\s*/, "") };
    const results = await attachPartialResults(Array.isArray(call.answer.results) ? call.answer.results : []);
    await dropRecordedJobs(results);
    return { ok: true, results };
  }
  if (message.type === "sync:tracking") {
    const tracking = core.parseTrackingPage({ url: message.url, carrierText: message.carrier, mailNoText: message.trackingNumber });
    if (!tracking) return { ok: false, error: "No tracking number to sync." };
    const call = await callApp("/api/extension/orders/sync-tracking", { method: "POST", body: tracking });
    if (call.error) return { ok: false, error: call.error };
    if (!call.ok) return { ok: false, error: core.explainRefusal(call.status, call.answer).replace(/^Not saved[:.]?\s*/, "") };
    return { ok: true, result: call.answer.result, orderName: call.answer.orderName ?? null, number: tracking.trackingNumber };
  }

  const job = await readJob(tabId);
  if (message.type === "checkout:get") return { ok: true, job };
  if (!job) return { ok: false, error: "This checkout has ended. Start it again from the extension's popup or the order in DropshipHub." };
  const item = job.items[job.itemIndex];

  switch (message.type) {
    case "checkout:open-confirm": {
      if (job.stage !== "product") return { ok: false, error: "This item is not waiting for its checkout page." };
      const url = String(message.url ?? "");
      if (!core.isConfirmPage(url) || core.confirmUrlMismatches(url, item, job.address.countryCode).length > 0) {
        return { ok: false, error: "The checkout page address did not match the item." };
      }
      await writeJob({ ...job, stage: "confirm" });
      await chrome.tabs.update(tabId, { url });
      return { ok: true };
    }
    case "checkout:reopen-product": {
      // A recorded item goes forward (Next item, Send), never back to its
      // product page, where a second checkout for it could start.
      if (job.stage === "recorded") return { ok: false, error: "This item's order number is already recorded." };
      // The panel reopens an item by itself when AliExpress answers with its
      // error page; that is noted per item, so it happens once and the tab
      // cannot be put in a reload loop by a checkout that keeps failing.
      const reopened = (Array.isArray(job.reopened) ? job.reopened : job.items.map(() => false)).map((value, index) => (index === job.itemIndex && message.automatic === true ? true : value === true));
      await writeJob({ ...job, stage: "product", fill: null, reopened });
      await chrome.tabs.update(tabId, { url: core.productPageUrl(item.externalProductId) });
      return { ok: true };
    }
    case "checkout:fill-result": {
      if (job.stage !== "confirm") return { ok: false, error: "This item is not on its checkout page." };
      const result = ["set", "partial", "failed"].includes(message.result) ? message.result : "failed";
      await writeJob({ ...job, fill: { itemIndex: job.itemIndex, result, reason: String(message.reason ?? "").slice(0, 300), at: Date.now() } });
      return { ok: true };
    }
    case "checkout:quote": {
      if (job.stage !== "confirm" && job.stage !== "paying") return { ok: false, error: "This item is not on its checkout page." };
      const quote = message.quote;
      if (!core.validQuote(quote)) return { ok: false, error: "The page's total could not be read." };
      const quotes = Array.isArray(job.quotes) ? job.quotes.slice() : job.items.map(() => null);
      // The same amounts again are not re-sent; different ones are, since the
      // page's total changes once the customer's address (its state's tax and
      // shipping) is set, and the endpoint takes a corrected total.
      const previous = quotes[job.itemIndex];
      if (previous?.sent && core.sameQuote(previous, quote)) return { ok: true, alreadySent: true };
      quotes[job.itemIndex] = { currency: quote.currency, total: quote.total, subtotal: quote.subtotal, shipping: quote.shipping, charges: quote.charges, sent: false };
      const answer = await postQuote({ ...job, quotes });
      if (answer.ok) quotes[job.itemIndex].sent = true;
      await writeJob({ ...job, quotes });
      return answer.ok ? { ok: true, sent: true, unchanged: answer.unchanged } : { ok: false, error: answer.error };
    }
    case "checkout:paying": {
      // Only observed: the merchant pressed Pay now on the confirm page.
      if (job.stage !== "confirm" && job.stage !== "paying") return { ok: false, error: "This item is not on its checkout page." };
      if (job.stage === "confirm") await writeJob({ ...job, stage: "paying", payingAt: Date.now() });
      return { ok: true };
    }
    case "checkout:not-paid": {
      // Pay now was pressed but AliExpress did not take the payment (a
      // validation message, a declined card): back to the checkout view.
      if (job.stage !== "paying") return { ok: false, error: "This item is not waiting for its payment." };
      await writeJob({ ...job, stage: "confirm", payingAt: null });
      return { ok: true };
    }
    case "checkout:open-orders": {
      const url = core.ordersPageUrl(senderOrigin(sender));
      if (!url) return { ok: false, error: "Not on AliExpress." };
      await chrome.tabs.update(tabId, { url });
      return { ok: true };
    }
    case "checkout:record": {
      if (!["confirm", "paying", "recorded"].includes(job.stage)) return { ok: false, error: "Open this item's checkout page first." };
      const parsed = core.parseOrderNumbers(Array.isArray(message.ids) ? message.ids.join(" ") : String(message.ids ?? ""));
      if (parsed.error) return { ok: false, error: parsed.error };
      const recordedOrderIds = job.recordedOrderIds.map((ids, index) => (index === job.itemIndex ? parsed.ids : ids));
      const next = { ...job, recordedOrderIds, stage: "recorded" };
      await writeJob(next);
      if (!core.isLastItem(next)) return { ok: true, done: false };
      return finish(next, message.paid);
    }
    case "checkout:send": {
      if (job.stage !== "recorded" || !core.isLastItem(job)) return { ok: false, error: "Record the last item's order number first." };
      return finish(job, message.paid);
    }
    case "checkout:next": {
      if (job.stage !== "recorded" || core.isLastItem(job)) return { ok: false, error: "Record this item's order number first." };
      const next = { ...job, itemIndex: job.itemIndex + 1, stage: "product", fill: null, payingAt: null };
      await writeJob(next);
      await chrome.tabs.update(tabId, { url: core.productPageUrl(next.items[next.itemIndex].externalProductId) });
      return { ok: true };
    }
    case "checkout:cancel": {
      await dropJob(tabId);
      return { ok: true };
    }
    default:
      return { ok: false, error: "Unknown request." };
  }
}

async function finish(job, paid) {
  const answer = await postPlaced(job, paid);
  // Recorded: the job and the address in it are no longer needed. A 404 (the
  // purchase order is gone) or 409 (recorded with other numbers, or its
  // Shopify order was cancelled) cannot succeed on a retry either, and the job
  // used to stay with the address in it. Unreachable, 401, 429 and the like:
  // the job stays, so the merchant can retry without typing the numbers again.
  const ended = !answer.ok && (answer.httpStatus === 404 || answer.httpStatus === 409);
  if (answer.ok || ended) await dropJob(job.tabId);
  return { ...answer, done: answer.ok, ended, orderName: job.orderName };
}

/**
 * The popup recorded the purchase order itself with "Mark as placed", or
 * learned it is gone. A checkout tab still open for it would otherwise keep
 * the customer's address in memory until it expired.
 */
async function forgetCheckout(purchaseOrderId) {
  if (!core.isPurchaseOrderId(purchaseOrderId)) return { ok: false, error: "No such order." };
  await sweep(purchaseOrderId);
  return { ok: true };
}

async function route(message, sender) {
  if (message.type === "checkout:start" || message.type === "checkout:forget" || message.type === "bridge:register") {
    if (!fromExtensionPage(sender)) return { ok: false, error: "Not allowed." };
    if (message.type === "bridge:register") return { ok: true, registered: await registerAppBridge() };
    return message.type === "checkout:start" ? startCheckout(message.order) : forgetCheckout(message.purchaseOrderId);
  }
  if (message.type === "checkout:start-by-id") {
    if (!(await fromAppPage(sender, message))) return { ok: false, error: "Not allowed." };
    return startCheckoutById(message.purchaseOrderId, { tabId: sender.tab.id, windowId: sender.tab.windowId, groupId: sender.tab.groupId });
  }
  if (fromAliExpressTab(sender)) return handleTabMessage(message, sender);
  return { ok: false, error: "Not allowed." };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || !/^(checkout|sync|bridge):/.test(message.type)) return false;
  // Expired jobs go first, on every message, so an abandoned job cannot
  // outlive its expiry just because its own tab never asks for it.
  sweep()
    .catch(() => undefined)
    .then(() => route(message, sender))
    .then(sendResponse, () => sendResponse({ ok: false, error: "Something went wrong in the extension. Try again." }));
  // Keeps the channel open for the asynchronous answer.
  return true;
});
