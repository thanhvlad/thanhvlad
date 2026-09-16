import prisma from "~/db.server";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { Decimal, d, round2 } from "~/lib/money";
import type { ShopSettings } from "~/domain/settings/shop-settings";

const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Exchange rate base -> quote. Cached in CurrencyRate and refreshed from the
 * configured provider at most twice a day. Falls back to the last known rate
 * (or 1 when nothing is known) so a provider outage never blocks pricing.
 */
export async function getRate(base: string, quote: string): Promise<Decimal> {
  return (await getKnownRate(base, quote)) ?? new Decimal(1);
}

/**
 * Exchange rate, or null when no rate is known for the pair.
 *
 * `getRate` falls back to 1 so pricing never blocks on a provider outage, which
 * is right for a markup but wrong for money: recording a CNY cost as if it were
 * GBP quietly corrupts every profit figure derived from it. Callers that store
 * a converted amount use this and simply record nothing when it returns null.
 */
export async function getKnownRate(base: string, quote: string): Promise<Decimal | null> {
  const from = base.toUpperCase();
  const to = quote.toUpperCase();
  if (!from || !to) return null;
  if (from === to) return new Decimal(1);

  const cached = await prisma.currencyRate.findUnique({ where: { base_quote: { base: from, quote: to } } });
  if (cached && Date.now() - cached.fetchedAt.getTime() < STALE_AFTER_MS) {
    return d(cached.rate);
  }

  try {
    await refreshRates(from);
    const fresh = await prisma.currencyRate.findUnique({ where: { base_quote: { base: from, quote: to } } });
    if (fresh) return d(fresh.rate);
  } catch (error) {
    logger.warn("Exchange rate refresh failed", { base: from, quote: to, error });
  }
  return cached ? d(cached.rate) : null;
}

/** Pull every rate for a base currency from the provider and store them. */
export async function refreshRates(base: string): Promise<number> {
  const url = `${env().EXCHANGE_RATE_API_URL.replace(/\/$/, "")}/${base.toUpperCase()}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Rate provider responded ${response.status}`);
  const body = (await response.json()) as { rates?: Record<string, number>; conversion_rates?: Record<string, number> };
  const rates = body.rates ?? body.conversion_rates ?? {};
  let count = 0;
  for (const [quote, rate] of Object.entries(rates)) {
    if (!Number.isFinite(rate) || rate <= 0) continue;
    await prisma.currencyRate.upsert({
      where: { base_quote: { base: base.toUpperCase(), quote: quote.toUpperCase() } },
      create: { base: base.toUpperCase(), quote: quote.toUpperCase(), rate: String(rate) },
      update: { rate: String(rate), fetchedAt: new Date() },
    });
    count += 1;
  }
  return count;
}

/**
 * Convert a supplier amount into the shop's currency, honouring the manual
 * override and safety buffer from settings.
 */
export async function convertToShopCurrency(
  amount: string | number | Decimal,
  fromCurrency: string,
  shopCurrency: string,
  settings: ShopSettings["currency"],
): Promise<Decimal> {
  const value = d(amount);
  if (fromCurrency.toUpperCase() === shopCurrency.toUpperCase()) return round2(value);
  const rate = settings.manualRate > 0 ? new Decimal(settings.manualRate) : await getRate(fromCurrency, shopCurrency);
  const buffer = new Decimal(1).plus(new Decimal(settings.bufferPercent).dividedBy(100));
  return round2(value.times(rate).times(buffer));
}

export async function listRates(base: string) {
  return prisma.currencyRate.findMany({ where: { base: base.toUpperCase() }, orderBy: { quote: "asc" } });
}
