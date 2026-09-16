/** Presentation helpers shared by the admin UI. Safe on both server and client. */

export function formatMoney(amount: string | number | null | undefined, currency = "USD", locale = "en-US"): string {
  const value = typeof amount === "string" ? Number(amount) : (amount ?? 0);
  if (!Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatNumber(value: number | null | undefined, locale = "en-US"): string {
  return new Intl.NumberFormat(locale).format(value ?? 0);
}

export function formatPercent(value: string | number | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  return `${Number.isFinite(n) ? n.toFixed(1) : "0.0"}%`;
}

export function formatDate(value: string | Date | null | undefined, locale = "en-US"): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatDay(value: string | Date | null | undefined, locale = "en-US"): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (Math.abs(minutes) < 1) return "just now";
  if (Math.abs(minutes) < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${days}d ago`;
  return formatDay(date);
}

export function truncate(value: string | null | undefined, max = 60): string {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Shopify gid -> numeric id for admin deep links. */
export function legacyId(gid: string | null | undefined): string {
  if (!gid) return "";
  const idx = gid.lastIndexOf("/");
  return idx >= 0 ? gid.slice(idx + 1) : gid;
}

export function adminUrl(shopDomain: string, path: string): string {
  const store = shopDomain.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${store}${path}`;
}

/**
 * Read a `?page=` value safely.
 *
 * `Number(searchParams.get("page") ?? 1)` only covers a *missing* param:
 * `?page=` gives 0 and `?page=abc` gives NaN, both of which reach Prisma's
 * `skip` and throw ("must be greater than or equal to 0"), dropping the merchant
 * on the error boundary instead of page 1. `Math.max(1, NaN)` is NaN, so the
 * service-side clamps did not save it either.
 */
export function pageParam(value: string | null | undefined, max = 100_000): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), max);
}
