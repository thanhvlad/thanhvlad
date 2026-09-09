/**
 * Strings used by the shared components in `app/components`, which belong to no
 * single screen. English is the source of truth; a key missing from `vi` falls
 * back to English.
 */
export const en = {
  "paginator.summary": "Page {page} of {pages} · {total} total",
} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {
  "paginator.summary": "Trang {page}/{pages} · {total} mục",
};
