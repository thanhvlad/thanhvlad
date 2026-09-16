/* global chrome */

/**
 * The bridge between a DropshipHub order page and the extension.
 *
 * Registered by the background worker once the merchant has granted the
 * matching optional host permission (the popup's "Allow access"), in two
 * places:
 *
 * - on the app's own origin, in every frame, where the page talks to itself
 *   and this script answers it - the behaviour since 1.6.0;
 * - on https://admin.shopify.com, in the TOP frame only, as a relay. Embedded
 *   in the Shopify admin the app is a cross-origin iframe, and the
 *   registration for the app's origin does not reach that frame (measured on
 *   the live account: the button said the extension had no access there,
 *   while the same bridge answered on the app's origin opened as a top-level
 *   page). The admin page's own script takes the app frame's message and
 *   answers it back to that frame.
 *
 * The page posts { source: "dropshiphub", type: "checkout:start",
 * purchaseOrderId }; this script relays the id to the worker, which fetches
 * the order from the app with the stored token and starts the checkout
 * exactly as the popup's Start checkout does. The page never hands over an
 * address or a token: only the purchase order's id.
 *
 * Which messages are accepted: on the app's origin, the page's own window and
 * origin, as before; in the relay, a frame whose origin is the configured app
 * origin (chrome.storage.sync's appUrl, the only stored value read here) and
 * no other - in particular nothing the admin page posts to itself. Every
 * answer goes back to that window with that origin as the target, never "*",
 * and the relay tells the worker which origin it accepted, which the worker
 * checks against the same setting.
 */
(() => {
  const EXTENSION = "dropshiphub-extension";
  const APP = "dropshiphub";
  const version = chrome.runtime.getManifest().version;

  /** The options page's app URL as an origin, by the same rule as the worker's. */
  function originOf(raw) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  async function configuredAppOrigin() {
    try {
      const stored = await chrome.storage.sync.get(["appUrl"]);
      return originOf(stored?.appUrl);
    } catch {
      return null;
    }
  }

  function post(target, targetOrigin, payload) {
    target.postMessage({ source: EXTENSION, version, ...payload }, targetOrigin);
  }

  function relay(purchaseOrderId, appOrigin, answer) {
    let sent;
    try {
      sent = chrome.runtime.sendMessage({ type: "checkout:start-by-id", purchaseOrderId, appOrigin });
    } catch {
      sent = Promise.resolve(null);
    }
    Promise.resolve(sent)
      .then((a) => {
        if (a && a.ok) answer({ type: "checkout:started", purchaseOrderId });
        else answer({ type: "checkout:error", purchaseOrderId, error: a?.error ?? "The extension did not answer. Reload this page and try again." });
      })
      .catch(() => answer({ type: "checkout:error", purchaseOrderId, error: "The extension was reloaded or updated. Reload this page and try again." }));
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data.source !== APP || typeof data.type !== "string") return;
    if (data.type !== "ping" && data.type !== "checkout:start") return;
    const sameWindow = event.source === window && event.origin === location.origin;
    configuredAppOrigin()
      .then((appOrigin) => {
        if (!appOrigin) return;
        // On the app's origin only the page's own window is heard, as before.
        // In the relay only the app's frame is, and never the admin page
        // itself: a message the relay accepted from anything else would ask
        // the worker to start a checkout for a page that is not the app.
        const onApp = location.origin === appOrigin;
        if (onApp ? !sameWindow : sameWindow || event.origin !== appOrigin || !event.source) return;
        const target = onApp ? window : event.source;
        const targetOrigin = onApp ? location.origin : event.origin;
        const answer = (payload) => post(target, targetOrigin, payload);
        // "ready" first, so the page knows within its wait that the extension
        // is here even when the app takes longer to answer.
        answer({ type: "ready" });
        if (data.type === "checkout:start") relay(String(data.purchaseOrderId ?? "").slice(0, 64), appOrigin, answer);
      })
      .catch(() => undefined);
  });

  // Announced on load on the app's own origin; the admin page has no
  // DropshipHub page of its own to tell, and its app frame asks with a ping.
  configuredAppOrigin()
    .then((appOrigin) => {
      if (appOrigin && location.origin === appOrigin) post(window, location.origin, { type: "ready" });
    })
    .catch(() => undefined);
})();
