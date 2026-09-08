import { describe, expect, it } from "vitest";
import { escapeHtml, renderNotificationEmail, shouldEmail } from "~/domain/notifications/email";

const prefs = { email: "owner@example.com", onOrderFailed: true, onPriceChange: false, onOutOfStock: true, onProductRemoved: true, onTrackingSynced: false, digest: false };

describe("shouldEmail", () => {
  it("follows the merchant's per-type toggles", () => {
    expect(shouldEmail(prefs, "order.failed", "warning")).toBe(true);
    expect(shouldEmail(prefs, "price.changed", "info")).toBe(false);
    expect(shouldEmail(prefs, "stock.out", "warning")).toBe(true);
    expect(shouldEmail(prefs, "tracking.synced", "info")).toBe(false);
  });

  it("never emails without an address, and always emails a critical notification", () => {
    expect(shouldEmail({ ...prefs, email: "" }, "order.failed", "critical")).toBe(false);
    expect(shouldEmail(prefs, "price.changed", "critical")).toBe(true);
    expect(shouldEmail(prefs, "supplier.auth", "warning")).toBe(true);
  });

  it("keeps job summaries in the feed", () => {
    expect(shouldEmail(prefs, "job.finished", "info")).toBe(false);
    expect(shouldEmail(prefs, "order.placed", "info")).toBe(false);
  });
});

describe("renderNotificationEmail", () => {
  const items = [
    { type: "order.failed", severity: "warning", title: "#1001 could not be placed", body: "Supplier out of stock", link: "/app/orders/abc", createdAt: new Date("2026-09-08T08:00:00Z") },
    { type: "stock.out", severity: "warning", title: "Watch <Blue>: 2 variant(s) out of stock", body: null, link: "/app/products/p1", createdAt: new Date("2026-09-08T09:00:00Z") },
  ];

  it("names the event in an instant subject and counts them in a digest", () => {
    const instant = renderNotificationEmail({ locale: "en", shopName: "Demo", shopDomain: "demo.myshopify.com", appUrl: "https://app.example.com/", items: [items[0]], digest: false });
    expect(instant.subject).toBe("[Demo] #1001 could not be placed");
    const digest = renderNotificationEmail({ locale: "en", shopName: "Demo", shopDomain: "demo.myshopify.com", appUrl: "https://app.example.com", items, digest: true });
    expect(digest.subject).toBe("[Demo] Daily digest: 2 notification(s)");
  });

  it("makes links absolute and escapes titles in the HTML body", () => {
    const rendered = renderNotificationEmail({ locale: "en", shopName: "Demo", shopDomain: "demo.myshopify.com", appUrl: "https://app.example.com/", items, digest: true });
    expect(rendered.text).toContain("https://app.example.com/app/orders/abc");
    expect(rendered.text).toContain("https://app.example.com/app/notifications");
    expect(rendered.html).toContain("Watch &lt;Blue&gt;");
    expect(rendered.html).not.toContain("<Blue>");
    // Newest first, so the stock notice comes before the failed order.
    expect(rendered.text.indexOf("Watch")).toBeLessThan(rendered.text.indexOf("#1001"));
  });

  it("speaks the shop's language", () => {
    const vi = renderNotificationEmail({ locale: "vi", shopName: "Demo", shopDomain: "demo.myshopify.com", appUrl: "https://app.example.com", items, digest: true });
    expect(vi.subject).toContain("Bản tin hằng ngày");
    expect(vi.text).toContain("Xin chào");
  });

  it("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
  });
});
