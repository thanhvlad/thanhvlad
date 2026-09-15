/* global chrome, importScripts, DropshipHubCheckout */

/**
 * The checkout assist's owner: one checkout job per tab.
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
 * A job is removed when its purchase order is recorded, when the merchant
 * cancels, when its tab closes, and when it is older than a few hours.
 */

importScripts("checkout-core.js");

const core = DropshipHubCheckout;
const JOB_PREFIX = "checkout:";
const FETCH_TIMEOUT_MS = 20000;

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
    return new URL(value).origin;
  } catch {
    return null;
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
  const { appUrl, token } = await chrome.storage.sync.get(["appUrl", "token"]);
  const base = appUrl ? appOrigin(appUrl) : null;
  if (!base || !token) return { ok: false, error: "Set the app URL and token in the extension options, then press Send again." };
  const ids = core.jobOrderIds(job);
  if (ids.length === 0) return { ok: false, error: "No AliExpress order number has been recorded yet." };
  if (ids.length > 20) return { ok: false, error: "A purchase order can carry at most 20 AliExpress order numbers." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/api/extension/orders/${encodeURIComponent(job.purchaseOrderId)}/placed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ externalOrderIds: ids, paid: paid === true }),
      cache: "no-store",
      signal: controller.signal,
    });
    const answer = await response.json().catch(() => ({}));
    if (response.status === 200 && answer.ok) {
      return { ok: true, alreadyRecorded: answer.alreadyRecorded === true, status: answer.status, externalOrderIds: ids };
    }
    return { ok: false, httpStatus: response.status, error: core.explainRefusal(response.status, answer) };
  } catch (error) {
    const reason = error?.name === "AbortError" ? "the app did not answer in time" : "the app could not be reached";
    return { ok: false, error: `Not saved: ${reason}. Check the app URL in the extension options and press Send again.` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function fromExtensionPage(sender) {
  return sender.id === chrome.runtime.id && !sender.tab && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

function fromAliExpressTab(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id)) return false;
  try {
    return core.isAliExpressHost(new URL(sender.url ?? sender.tab.url ?? "").hostname);
  } catch {
    return false;
  }
}

async function startCheckout(order) {
  const built = core.buildJob(order, null, Date.now());
  if (built.error) return { ok: false, error: built.error };
  // Starting the same purchase order again replaces the older job, so two
  // tabs cannot both collect order numbers for it.
  await sweep(built.job.purchaseOrderId);
  // An about:blank tab first, so the job is stored before any AliExpress page
  // in that tab can ask for it; opening the product directly would race the
  // write against the page's content script.
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const job = { ...built.job, tabId: tab.id };
  await writeJob(job);
  await chrome.tabs.update(tab.id, { url: core.productPageUrl(job.items[0].externalProductId) });
  return { ok: true };
}

async function handleTabMessage(message, tabId) {
  const job = await readJob(tabId);
  if (message.type === "checkout:get") return { ok: true, job };
  if (!job) return { ok: false, error: "This checkout has ended. Start it again from the extension's popup." };
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
      await writeJob({ ...job, stage: "product" });
      await chrome.tabs.update(tabId, { url: core.productPageUrl(item.externalProductId) });
      return { ok: true };
    }
    case "checkout:record": {
      if (job.stage !== "confirm" && job.stage !== "recorded") return { ok: false, error: "Open this item's checkout page first." };
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
      const next = { ...job, itemIndex: job.itemIndex + 1, stage: "product" };
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
  // Recorded: the job and the address in it are no longer needed. Refused or
  // unreachable: the job stays, so the merchant can retry or cancel without
  // typing the order numbers again.
  if (answer.ok) await dropJob(job.tabId);
  return { ...answer, done: answer.ok, orderName: job.orderName };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || !message.type.startsWith("checkout:")) return false;
  let work;
  if (message.type === "checkout:start") {
    work = fromExtensionPage(sender) ? startCheckout(message.order) : Promise.resolve({ ok: false, error: "Not allowed." });
  } else if (fromAliExpressTab(sender)) {
    work = handleTabMessage(message, sender.tab.id);
  } else {
    work = Promise.resolve({ ok: false, error: "Not allowed." });
  }
  work.then(sendResponse, () => sendResponse({ ok: false, error: "Something went wrong in the extension. Try again." }));
  // Keeps the channel open for the asynchronous answer.
  return true;
});
