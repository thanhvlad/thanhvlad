/* global chrome, globalThis */

/**
 * Order-number and tracking sync, on the merchant's own AliExpress pages.
 *
 * On the orders list (/p/order/index.html) every order card's AliExpress
 * order id, product ids, SKU text, status, total and date are read and sent
 * to the app, which records the order number on the DropshipHub purchase
 * order it matches and advances the status of the ones it already knows. On
 * an order's detail page the one order is read the same way. On a tracking
 * page the order id, carrier and tracking number are read and the tracking
 * is added to the matching purchase order.
 *
 * Nothing else on these pages is read. They also print the customer's
 * address and a masked name; those never leave the page. The parsing itself
 * is in checkout-core.js (parseOrderCard, parseOrderDetail,
 * parseTrackingPage) and works on plain values pulled out here, so it is unit
 * tested without a DOM. The small panel is built with textContent in a
 * closed shadow root, and nothing is added to a page with nothing to report.
 */
(() => {
  const core = globalThis.DropshipHubCheckout;
  if (!core || window.top !== window) return;

  const HOST_ID = "dropshiphub-sync-host";
  const RELOADED = "The extension was reloaded or updated. Reload this page.";

  let panel = null;
  let lastUrl = location.href;
  let lastSent = "";
  let running = false;

  function ask(message) {
    try {
      return chrome.runtime
        .sendMessage(message)
        .then((answer) => answer ?? { ok: false, error: "The extension did not answer. Reload this page." })
        .catch(() => ({ ok: false, error: RELOADED }));
    } catch {
      return Promise.resolve({ ok: false, error: RELOADED });
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(probe, timeoutMs, intervalMs = 400) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try {
        value = probe();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }

  // ---------------------------------------------------------------------------
  // The panel (textContent only)
  // ---------------------------------------------------------------------------

  const STYLES = `
    :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 320px; }
    .card { background: #fff; color: #202223; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.28);
      font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; max-height: 50vh; display: flex; flex-direction: column; }
    .head { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid #e1e3e5;
      font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: #6d7175; }
    .head button { border: 0; background: none; cursor: pointer; color: #6d7175; font-size: 16px; line-height: 1; padding: 0 4px; }
    .body { padding: 8px 12px 10px; overflow: auto; display: grid; gap: 6px; }
    .line { font-size: 12.5px; }
    .ok { color: #1a7f37; } .warn { color: #8a6116; } .err { color: #b3261e; } .muted { color: #6d7175; }
    button.act { font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; background: #f1f2f3; color: #202223; }
  `;

  function el(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
    if (options.type) node.type = options.type;
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function mountPanel() {
    if (panel && panel.host.isConnected) return panel;
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLES;
    const body = el("div", { className: "body" });
    const close = el("button", { text: "×", type: "button" });
    close.title = "Hide";
    close.addEventListener("click", () => {
      host.remove();
      panel = null;
    });
    root.append(style, el("div", { className: "card" }, [el("div", { className: "head" }, [el("span", { text: "DropshipHub sync" }), close]), body]));
    (document.body ?? document.documentElement).append(host);
    panel = { host, body };
    return panel;
  }

  function show(lines, retry) {
    const { body } = mountPanel();
    body.textContent = "";
    for (const [text, tone] of lines) body.append(el("div", { className: `line ${tone ?? ""}`.trim(), text }));
    const again = el("button", { className: "act", text: "Check again", type: "button" });
    again.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      lastSent = "";
      retry();
    });
    body.append(again);
  }

  // ---------------------------------------------------------------------------
  // Reading the pages (plain values only; the parsing is in checkout-core.js)
  // ---------------------------------------------------------------------------

  function hrefs(scope, selector) {
    return [...scope.querySelectorAll(selector)].map((a) => a.getAttribute("href") ?? "");
  }

  function readCards() {
    return [...document.querySelectorAll(".order-item")]
      .map((card) =>
        core.parseOrderCard({
          detailsHref: card.querySelector('a[href*="/p/order/detail.html"]')?.getAttribute("href") ?? "",
          productHrefs: hrefs(card, 'a[href*="/item/"]'),
          statusText: card.querySelector('[class*="status"]')?.textContent ?? "",
          skuText: [...card.querySelectorAll('[class*="sku"]')].map((node) => node.textContent ?? "").join(" "),
          cardText: card.textContent ?? "",
        }),
      )
      .filter(Boolean);
  }

  /**
   * The detail page's order id and status only. Its product links are not
   * read: the page's own item block has not been measured and its
   * recommendation strips link products too, so the app could match one of
   * those to a waiting purchase order. From here the app only advances an
   * order it already knows by number.
   */
  function readDetail() {
    const rows = [...document.querySelectorAll(".order-detail-order-info .info-row")].map((row) => row.textContent ?? "");
    return core.parseOrderDetail({
      url: location.href,
      refNumberText: rows.find((text) => /Ref\.?\s*Number/i.test(text)) ?? "",
      statusText: document.querySelector(".order-status")?.textContent ?? "",
    });
  }

  function readTracking() {
    return core.parseTrackingPage({
      url: location.href,
      carrierText: document.querySelector('[class*="logistic-info-v2--carrierTitle"]')?.textContent ?? "",
      mailNoText: document.querySelector('[class*="logistic-info-v2--mailNoValue"]')?.textContent ?? "",
    });
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  async function syncOrders(orders) {
    const key = JSON.stringify(orders.map((o) => [o.orderId, o.status]));
    if (key === lastSent) return;
    lastSent = key;
    const answer = await ask({ type: "sync:orders", orders });
    if (!answer.ok) {
      show([[`Not synced: ${answer.error}`, "err"]], run);
      return;
    }
    const results = Array.isArray(answer.results) ? answer.results : [];
    if (results.length === 0) return;
    // An unmatched order with a reason (closed, or dated before the order
    // waiting for its product) is worth a line; the rest are counted.
    const noted = results.filter((r) => r.result !== "unmatched" || r.closed || r.reason);
    const lines = noted.map((r) => [core.describeSyncResult(r), ["recorded", "advanced", "partial"].includes(r.result) ? "ok" : r.result === "ambiguous" ? "warn" : "muted"]);
    const unmatched = results.length - noted.length;
    if (unmatched > 0) lines.push([`${unmatched} AliExpress order${unmatched === 1 ? "" : "s"} on this page: no DropshipHub order matched.`, "muted"]);
    show(lines, run);
  }

  async function syncTracking(tracking) {
    const key = JSON.stringify([tracking.tradeOrderId, tracking.trackingNumber]);
    if (key === lastSent) return;
    lastSent = key;
    const answer = await ask({ type: "sync:tracking", url: location.href, carrier: tracking.carrier, trackingNumber: tracking.trackingNumber });
    if (!answer.ok) {
      show([[`Tracking not synced: ${answer.error}`, "err"]], run);
      return;
    }
    const name = answer.orderName ? `${answer.orderName}: ` : "";
    if (answer.result === "added") show([[`${name}tracking ${answer.number} recorded and sent to Shopify.`, "ok"]], run);
    else if (answer.result === "known") show([[`${name}tracking ${answer.number} was already recorded.`, "muted"]], run);
    else if (answer.result === "cancelled") show([[`${name}is cancelled in DropshipHub, so tracking ${answer.number} was not added.`, "muted"]], run);
    else show([[`Tracking ${answer.number}: no DropshipHub order has AliExpress order ${tracking.tradeOrderId}.`, "muted"]], run);
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      const url = location.href;
      if (core.isTrackingPage(url)) {
        const tracking = await waitFor(readTracking, 15000);
        if (tracking) await syncTracking(tracking);
      } else if (core.isOrderDetailPage(url)) {
        const detail = await waitFor(readDetail, 15000);
        if (detail) await syncOrders([detail]);
      } else if (core.isOrdersPage(url)) {
        const cards = await waitFor(() => {
          const list = readCards();
          return list.length > 0 ? list : null;
        }, 15000);
        if (cards) await syncOrders(cards);
      }
    } finally {
      running = false;
    }
  }

  function start() {
    run();
    // The list changes tabs client-side (View all / To pay / …); each new
    // page URL is a fresh read.
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      run();
    }, 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
