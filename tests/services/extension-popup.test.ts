/**
 * The extension popup and the words the app uses for ordering through it.
 *
 * The popup is plain browser JavaScript with no build step, so it is checked by
 * reading its source: that it reports placement and tracking to the routes the
 * server exposes, writes nothing through innerHTML (its page holds the token),
 * and describes placement in exactly the words the app uses everywhere.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { en as ordersEn } from "~/lib/i18n-modules/orders";

const C1 =
  "The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress. You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify.";

const popup = readFileSync(resolve(__dirname, "../../extension/popup.js"), "utf8");
const popupHtml = readFileSync(resolve(__dirname, "../../extension/popup.html"), "utf8");

describe("extension popup", () => {
  it("reports placement and tracking to the server's routes", () => {
    expect(popup).toContain("/api/extension/orders/${encodeURIComponent(order.id)}/placed");
    expect(popup).toContain("/api/extension/orders/${encodeURIComponent(po.id)}/tracking");
    expect(popup).toMatch(/externalOrderIds: parsed\.ids/);
    expect(popup).toContain("Mark as placed");
    expect(popup).toContain("Add tracking");
  });

  it("builds every node with textContent, never markup", () => {
    expect(popup).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\(|document\.write\(/);
  });

  it("has the elements the script writes to", () => {
    for (const id of ["orders-result", "orders-heading", "orders-status", "orders", "tracking-heading", "tracking-status", "tracking"]) {
      expect(popupHtml).toContain(`id="${id}"`);
    }
  });

  it("describes placement the one way the app does", () => {
    expect(popup).toContain(C1);
    for (const key of ["orders.placement.body", "orders.placement.listBannerBody", "orders.placement.paymentsBannerBody", "orders.payments.howItWorks.body"] as const) {
      expect(ordersEn[key]).toContain(C1);
    }
    // Never that the extension places or pays by itself.
    const everything = [popup, ...Object.values(ordersEn)].join("\n");
    expect(everything).not.toMatch(/extension (places|pays|will place|will pay)/i);
  });
});
