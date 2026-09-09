/**
 * Strings for this screen group. English is the source of truth; a key missing
 * from `vi` falls back to English. Keep keys namespaced by screen
 * (e.g. "orders.table.customer") so two groups can never collide.
 */
export const en = {} as const;

export const vi: Partial<Record<keyof typeof en, string>> = {};
