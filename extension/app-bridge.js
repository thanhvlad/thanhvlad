/* global chrome */

/**
 * The bridge between a DropshipHub order page and the extension.
 *
 * Registered by the background worker for the app's origin only once the
 * merchant has granted that optional host permission (the popup's "Allow
 * access"). The page posts { source: "dropshiphub", type: "checkout:start",
 * purchaseOrderId } to its own window; this script relays the id to the
 * worker, which fetches the order from the app with the stored token and
 * starts the checkout exactly as the popup's Start checkout does. The page
 * never hands over an address or a token: only the purchase order's id.
 *
 * Messages are accepted from the page's own window and origin only, and
 * every answer goes back the same way.
 */
(() => {
  const EXTENSION = "dropshiphub-extension";
  const APP = "dropshiphub";
  const version = chrome.runtime.getManifest().version;

  function post(payload) {
    window.postMessage({ source: EXTENSION, version, ...payload }, location.origin);
  }

  function relay(purchaseOrderId) {
    let answer;
    try {
      answer = chrome.runtime.sendMessage({ type: "checkout:start-by-id", purchaseOrderId });
    } catch {
      answer = Promise.resolve(null);
    }
    Promise.resolve(answer)
      .then((a) => {
        if (a && a.ok) post({ type: "checkout:started", purchaseOrderId });
        else post({ type: "checkout:error", purchaseOrderId, error: a?.error ?? "The extension did not answer. Reload this page and try again." });
      })
      .catch(() => post({ type: "checkout:error", purchaseOrderId, error: "The extension was reloaded or updated. Reload this page and try again." }));
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== "object" || data.source !== APP || typeof data.type !== "string") return;
    if (data.type === "ping") {
      post({ type: "ready" });
    } else if (data.type === "checkout:start") {
      // "ready" first, so the page knows within its wait that the extension
      // is here even when the app takes longer to answer.
      post({ type: "ready" });
      relay(String(data.purchaseOrderId ?? "").slice(0, 64));
    }
  });

  post({ type: "ready" });
})();
