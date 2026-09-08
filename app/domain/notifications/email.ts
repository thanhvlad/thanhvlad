import { translate, type Locale } from "~/lib/i18n";

/**
 * Notification emails.
 *
 * Pure: takes the rows the service already stored and renders a subject, a
 * plain-text body and an HTML body. Nothing here knows how mail is sent, so a
 * template change is a unit test away and a provider change never touches it.
 */

export interface EmailNotificationItem {
  type: string;
  severity: string;
  title: string;
  body?: string | null;
  /** App-relative link ("/app/orders/abc"), turned absolute with `appUrl`. */
  link?: string | null;
  createdAt: Date;
}

export interface NotificationEmailInput {
  locale: Locale;
  shopName: string;
  shopDomain: string;
  /** Public app URL, used to make links clickable from an inbox. */
  appUrl: string;
  items: EmailNotificationItem[];
  /** A digest gathers a day's notifications; otherwise it is one event, sent at once. */
  digest: boolean;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface NotificationEmailPrefs {
  email: string;
  onOrderFailed: boolean;
  onPriceChange: boolean;
  onOutOfStock: boolean;
  onProductRemoved: boolean;
  onTrackingSynced: boolean;
  digest: boolean;
}

/**
 * Whether a notification type is one the merchant asked to be emailed about.
 *
 * A critical notification always goes out: it is the app saying the merchant
 * must do something (reconnect a supplier, fix a blocked order) and a muted
 * category is not consent to miss that.
 */
export function shouldEmail(prefs: NotificationEmailPrefs, type: string, severity: string): boolean {
  if (!prefs.email || !prefs.email.includes("@")) return false;
  if (severity === "critical") return true;
  switch (type) {
    case "order.failed":
      return prefs.onOrderFailed;
    case "price.changed":
      return prefs.onPriceChange;
    case "stock.out":
    case "stock.back":
      return prefs.onOutOfStock;
    case "product.removed":
      return prefs.onProductRemoved;
    case "tracking.synced":
    case "order.shipped":
      return prefs.onTrackingSynced;
    case "supplier.auth":
      return true;
    default:
      // Job summaries and informational notes stay in the in-app feed.
      return false;
  }
}

export function renderNotificationEmail(input: NotificationEmailInput): RenderedEmail {
  const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(input.locale, key, vars);
  const items = [...input.items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const first = items[0];
  const subject = input.digest
    ? t("email.subject.digest", { shop: input.shopName, n: items.length })
    : t("email.subject.instant", { shop: input.shopName, title: first?.title ?? "" });

  const feedUrl = absolute(input.appUrl, "/app/notifications");
  const lines: string[] = [t("email.greeting", { shop: input.shopName }), ""];
  for (const item of items) {
    lines.push(`• ${item.title}`);
    if (item.body) lines.push(`  ${item.body}`);
    if (item.link) lines.push(`  ${absolute(input.appUrl, item.link)}`);
    lines.push("");
  }
  lines.push(t("email.open", { url: feedUrl }));
  lines.push("");
  lines.push(t("email.footer", { shop: input.shopDomain }));
  const text = lines.join("\n");

  const rows = items
    .map((item) => {
      const tone = item.severity === "critical" ? "#b00020" : item.severity === "warning" ? "#8a6d00" : "#1a1a1a";
      const link = item.link ? absolute(input.appUrl, item.link) : null;
      return `<tr><td style="padding:12px 0;border-bottom:1px solid #e5e5e5;">
<div style="font-weight:600;color:${tone};">${escapeHtml(item.title)}</div>
${item.body ? `<div style="color:#555;margin-top:4px;">${escapeHtml(item.body)}</div>` : ""}
${link ? `<div style="margin-top:6px;"><a href="${escapeAttribute(link)}" style="color:#005bd3;">${escapeHtml(t("email.viewInApp"))}</a></div>` : ""}
</td></tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1a1a;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;">
<p style="margin:0 0 16px;">${escapeHtml(t("email.greeting", { shop: input.shopName }))}</p>
<table role="presentation" style="width:100%;border-collapse:collapse;">${rows}</table>
<p style="margin:20px 0 0;"><a href="${escapeAttribute(feedUrl)}" style="display:inline-block;padding:10px 16px;background:#1a1a1a;color:#fff;border-radius:6px;text-decoration:none;">${escapeHtml(t("email.openButton"))}</a></p>
<p style="margin:24px 0 0;color:#777;font-size:12px;">${escapeHtml(t("email.footer", { shop: input.shopDomain }))}</p>
</div></body></html>`;

  return { subject, text, html };
}

function absolute(appUrl: string, link: string): string {
  if (/^https?:\/\//i.test(link)) return link;
  return `${appUrl.replace(/\/+$/, "")}${link.startsWith("/") ? link : `/${link}`}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
