import { randomBytes } from "node:crypto";
import type { Session } from "@shopify/shopify-api";
import type { Prisma, Shop } from "@prisma/client";
import prisma from "~/db.server";
import { AppError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { PLANS, isPlanId } from "~/domain/billing/plans";
import { parseShopSettings, type ShopSettings } from "~/domain/settings/shop-settings";
import { fetchShopInfo } from "./shopify/shop.server";
import type { GraphqlClient } from "./shopify/graphql.server";
import { logActivity } from "./activity.server";
import { assertWithinPlan, paysForAccountPlan, releasePlanOnUninstall } from "./billing.server";

export type ShopWithSettings = Shop & { parsedSettings: ShopSettings };

export function withSettings(shop: Shop): ShopWithSettings {
  return { ...shop, parsedSettings: parseShopSettings(shop.settings) };
}

/**
 * Load (or lazily create) the Shop row for a Shopify session.
 *
 * A store's very first request runs the parent `/app` loader and the child
 * page loader concurrently, and afterAuth calls this again on top. Each of
 * them misses the read and races to create; the losers used to get a unique
 * violation on `domain` — a 500 on the merchant's first screen — and each had
 * already created an Account nobody would ever reference. The Account and the
 * Shop are now created together, so a loser leaves nothing behind, and a loser
 * simply reads the row the winner made.
 */
export async function getOrCreateShop(domain: string): Promise<ShopWithSettings> {
  const existing = await prisma.shop.findUnique({ where: { domain } });
  if (existing) return withSettings(existing);

  let shop: Shop;
  try {
    shop = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: { name: domain.replace(".myshopify.com", "") },
      });
      return tx.shop.create({
        data: {
          domain,
          accountId: account.id,
          inventoryPolicy: { create: {} },
        },
      });
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "P2002") throw error;
    const won = await prisma.shop.findUnique({ where: { domain } });
    if (!won) throw error;
    return withSettings(won);
  }

  await logActivity(shop.id, {
    action: "shop.created",
    message: `Shop ${domain} registered.`,
  });
  return withSettings(shop);
}

export async function getShopByDomain(domain: string): Promise<ShopWithSettings | null> {
  const shop = await prisma.shop.findUnique({ where: { domain } });
  return shop ? withSettings(shop) : null;
}

export async function getShopById(id: string): Promise<ShopWithSettings | null> {
  const shop = await prisma.shop.findUnique({ where: { id } });
  return shop ? withSettings(shop) : null;
}

/** How often afterAuth re-verifies a store's webhook subscriptions. */
const WEBHOOK_CHECK_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Whether afterAuth should verify the store's webhook subscriptions now.
 *
 * afterAuth runs on every token exchange, and with online tokens that is every
 * staff member roughly once a day, so registering fifteen topics each time was
 * pure latency on the merchant's first screen. A reinstall always checks:
 * Shopify deletes a store's shop-level subscriptions when the app is removed.
 */
export function webhookCheckDue(checkedAt: Date | null | undefined, reinstalled: boolean, now: Date = new Date()): boolean {
  if (reinstalled || !checkedAt) return true;
  return now.getTime() - checkedAt.getTime() > WEBHOOK_CHECK_INTERVAL_MS;
}

/**
 * afterAuth hook: make sure a Shop row exists, refresh the store profile from
 * Shopify and mark the app installed again if it was previously removed.
 *
 * `graphql` must be the offline client. afterAuth is handed the staff member's
 * online session, whose token carries only that person's permissions.
 */
export async function onShopInstalled({
  session,
  graphql,
  authenticatedAt = new Date(),
}: {
  session: Pick<Session, "shop">;
  graphql: GraphqlClient;
  authenticatedAt?: Date;
}): Promise<{ shop: ShopWithSettings; reinstalled: boolean; webhooksDue: boolean }> {
  const shop = await getOrCreateShop(session.shop);
  // A store whose uninstall was recorded, or that is marked inactive, is back.
  const reinstalled = Boolean(shop.uninstalledAt) || !shop.isActive;

  let profile: Prisma.ShopUpdateInput = {};
  try {
    const info = await fetchShopInfo(graphql);
    profile = {
      name: info.name,
      email: info.email,
      country: info.countryCode,
      currency: info.currencyCode,
      timezone: info.ianaTimezone,
      moneyFormat: info.moneyFormat,
      primaryLocationId: info.primaryLocationId,
      isDevelopmentStore: info.isDevelopmentStore,
    };
  } catch (error) {
    logger.warn("Could not fetch shop profile after auth", { shop: session.shop, error });
  }

  const updated = await prisma.shop.update({
    where: { id: shop.id },
    data: {
      ...profile,
      isActive: true,
      uninstalledAt: null,
      installedAt: reinstalled ? authenticatedAt : shop.installedAt,
      // The install generation markShopUninstalled compares against.
      lastAuthAt: authenticatedAt,
      ...(reinstalled ? { webhooksCheckedAt: null } : {}),
    },
  });

  if (reinstalled) {
    await logActivity(shop.id, { action: "shop.reinstalled", message: "App reinstalled." });
  }

  await backfillOrdersOnInstall(shop.id);
  return { shop: withSettings(updated), reinstalled, webhooksDue: webhookCheckDue(shop.webhooksCheckedAt, reinstalled, authenticatedAt) };
}

/** Stamp a successful webhook verification, so the next afterAuth can skip it. */
export async function markWebhooksChecked(shopDomain: string, at: Date = new Date()) {
  await prisma.shop.updateMany({ where: { domain: shopDomain }, data: { webhooksCheckedAt: at } });
}

/**
 * A fresh install pulls in the last 30 days of orders, so the Orders page is
 * not empty until the next webhook and the merchant can start with the orders
 * they already have — which is what DSers does and what a reviewer expects to
 * see. Only runs while the store has no orders at all: a re-auth or a
 * reinstall of a store with history must not queue a second sync.
 *
 * The job module is loaded lazily: it imports every service, and a static
 * import here would create a cycle back through the Shopify client.
 */
async function backfillOrdersOnInstall(shopId: string) {
  try {
    const existing = await prisma.order.count({ where: { shopId } });
    if (existing > 0) return;
    const [{ findOrCreateJobRun }, { enqueue }] = await Promise.all([import("./jobs.server"), import("./jobs/index.server")]);
    const { job, reused } = await findOrCreateJobRun({ shopId, type: "sync-orders", payload: { days: 30, reason: "install" } });
    if (!reused) {
      await enqueue("sync-orders", { shopId, days: 30, jobRunId: job.id }, { dedupeKey: `sync-orders-${shopId}` });
    }
  } catch (error) {
    logger.warn("Could not queue the install order backfill", { shopId, error });
  }
}

/**
 * How much later than an uninstall's trigger time a token exchange must be to
 * prove a reinstall, once the measured clock lead has been taken off.
 *
 * lastAuthAt is stamped on this server's clock and X-Shopify-Triggered-At on
 * Shopify's. A fixed 30 seconds was the whole allowance before, so a server
 * clock running a minute fast turned the merchant's last visit before
 * uninstalling into a "reinstall" and the real uninstall was ignored. The lead
 * is now measured from recent deliveries (estimateClockLeadMs in
 * webhooks.server), and because that measurement includes delivery delay it can
 * only overstate the lead, never understate it. What the margin still has to
 * cover is Shopify's own clock jitter between the event and our sample, which
 * is sub-second on NTP-disciplined hosts. Sixty seconds covers that many times
 * over and stays below the fastest real reinstall, which needs the merchant to
 * open the listing again and approve the app.
 */
export const REAUTH_MARGIN_MS = 60_000;

/**
 * Whether the store authenticated after the uninstall was triggered, which
 * proves it reinstalled: Shopify refuses a token exchange for an app that is
 * not installed. `clockLeadMs` is how far this server's clock may run ahead of
 * Shopify's; a negative value is treated as none, since running behind makes a
 * sign-in look earlier and so can only apply an uninstall. Exported for the test.
 */
export function reauthenticatedSince(lastAuthAt: Date | null | undefined, triggeredAt: Date | null | undefined, clockLeadMs = 0): boolean {
  if (!lastAuthAt || !triggeredAt) return false;
  return lastAuthAt.getTime() - Math.max(0, clockLeadMs) > triggeredAt.getTime() + REAUTH_MARGIN_MS;
}

/**
 * app/uninstalled: mark the store inactive, drop its sessions and the plan it
 * was paying for.
 *
 * Shopify does not order webhook deliveries, and a delivery can wait in a
 * retry or the recovery sweep. Applied late, this used to delete the fresh
 * sessions of a store that had already reinstalled and switch it off: every
 * background job skipped it, the extension was refused, and the retention purge
 * erased it 30 days later. An uninstall triggered before the store's latest
 * token exchange is therefore ignored. Returns whether the store was uninstalled.
 */
export async function markShopUninstalled(domain: string, options: { triggeredAt?: Date | null; now?: Date; clockLeadMs?: number } = {}): Promise<boolean> {
  const shop = await prisma.shop.findUnique({ where: { domain } });
  if (!shop) return false;
  const now = options.now ?? new Date();
  const triggeredAt = options.triggeredAt ?? now;
  const clockLeadMs = Math.max(0, options.clockLeadMs ?? 0);
  const reinstalled = reauthenticatedSince(shop.lastAuthAt, triggeredAt, clockLeadMs);
  // Logged either way with every input, so a disputed decision can be checked
  // against the clocks afterwards instead of guessed at.
  logger.info("app/uninstalled decision", {
    shop: domain,
    decision: reinstalled ? "ignored: store authenticated after the uninstall" : "applied",
    triggeredAt,
    lastAuthAt: shop.lastAuthAt,
    clockLeadMs,
    marginMs: REAUTH_MARGIN_MS,
  });

  if (reinstalled) {
    // Shopify deleted the store's shop-level webhook subscriptions with the
    // uninstall, so the next afterAuth must register them again.
    await prisma.shop.update({ where: { id: shop.id }, data: { webhooksCheckedAt: null } });
    await logActivity(shop.id, { action: "shop.uninstall_ignored", message: "A delayed uninstall notice arrived after the app was reinstalled and was ignored." });
    return false;
  }

  // Conditional on the auth stamp read above: a token exchange landing between
  // the read and this write means a reinstall is in progress, and it wins.
  const { count } = await prisma.shop.updateMany({
    where: { id: shop.id, lastAuthAt: shop.lastAuthAt },
    data: { isActive: false, uninstalledAt: now },
  });
  if (count === 0) {
    logger.info("Store re-authenticated while its uninstall was being applied; keeping it installed", { shop: domain });
    return false;
  }
  await prisma.session.deleteMany({ where: { shop: domain } });
  // Not swallowed: a failure fails the event, and its retry repeats the release.
  await releasePlanOnUninstall(shop);
  await logActivity(shop.id, { action: "shop.uninstalled", message: "App uninstalled." });
  return true;
}

export async function updateShopSettings(shopId: string, settings: ShopSettings) {
  return prisma.shop.update({
    where: { id: shopId },
    data: { settings: settings as unknown as Prisma.InputJsonValue },
  });
}

export async function setOnboardingStep(shopId: string, step: string) {
  return prisma.shop.update({ where: { id: shopId }, data: { onboardingStep: step } });
}

/** Sister stores under the same account, for the multi-store switcher. */
export async function listAccountShops(accountId: string | null) {
  if (!accountId) return [];
  return prisma.shop.findMany({
    where: { accountId },
    orderBy: { installedAt: "asc" },
    select: { id: true, domain: true, name: true, isActive: true, currency: true },
  });
}

/** How long an account invite code stays valid. */
const INVITE_TTL_MS = 24 * 60 * 60_000;
/** No 0/O or 1/I, so a code read aloud or retyped from a screenshot survives. */
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** An account link refused for a reason the merchant can act on. Localisable. */
export class AccountLinkError extends AppError {
  readonly messageKey: string;
  readonly messageVars: Record<string, string | number>;

  constructor(message: string, messageKey: string, messageVars: Record<string, string | number> = {}) {
    super("ACCOUNT_LINK", message);
    this.name = "AccountLinkError";
    this.messageKey = messageKey;
    this.messageVars = messageVars;
  }
}

/** A fresh invite code, grouped for reading: XXXX-XXXX-XXXX. */
export function generateInviteCode(): string {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((group) => group.join("")).join("-");
}

/** The stored form of whatever the merchant pasted; null when it cannot be a code. */
export function normalizeInviteCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 12 || [...raw].some((c) => !INVITE_ALPHABET.includes(c))) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/**
 * Create (or replace) the account's invite code.
 *
 * The code used to be the raw account id, shown to every admin and valid
 * forever, and joining needed nothing else: any store that learned it joined
 * and inherited the account's paid plan. A code now exists only when an owner
 * creates it, works once, and expires after a day.
 */
export async function createAccountInvite(accountId: string, now: Date = new Date()) {
  const joinCode = generateInviteCode();
  const joinCodeExpiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await prisma.account.update({ where: { id: accountId }, data: { joinCode, joinCodeExpiresAt } });
  return { joinCode, joinCodeExpiresAt };
}

/** Move a store under the account an invite code belongs to, using the code up. */
export async function joinAccountWithInvite(shop: Pick<Shop, "id" | "domain" | "accountId">, input: string, now: Date = new Date()) {
  const code = normalizeInviteCode(input);
  if (!code) throw new AccountLinkError("That invite code is not valid.", "billing.stores.error.codeInvalid");
  const target = await prisma.account.findUnique({ where: { joinCode: code } });
  if (!target || !target.joinCodeExpiresAt || target.joinCodeExpiresAt <= now) {
    throw new AccountLinkError("That invite code is not valid or has expired.", "billing.stores.error.codeInvalid");
  }
  if (target.id === shop.accountId) throw new AccountLinkError("This store is already on that account.", "billing.stores.error.sameAccount");
  await assertNotPayingStore(shop);
  await assertWithinPlan({ accountId: target.id }, "stores", 1);

  const previous = shop.accountId;
  await prisma.$transaction(async (tx) => {
    // Consumed in the same transaction as the move: two stores racing on one
    // code cannot both get in.
    const { count } = await tx.account.updateMany({
      where: { id: target.id, joinCode: code, joinCodeExpiresAt: { gt: now } },
      data: { joinCode: null, joinCodeExpiresAt: null },
    });
    if (count === 0) throw new AccountLinkError("That invite code has just been used.", "billing.stores.error.codeInvalid");
    await tx.shop.update({ where: { id: shop.id }, data: { accountId: target.id } });
  });
  if (previous) {
    const remaining = await prisma.shop.count({ where: { accountId: previous } });
    if (remaining === 0) await prisma.account.delete({ where: { id: previous } }).catch(() => undefined);
  }
  await logActivity(shop.id, { action: "shop.joined_account", message: `Store joined account "${target.name}".` });
  return target;
}

/** Give a store an account of its own again. */
export async function leaveAccount(shop: Pick<Shop, "id" | "domain" | "accountId">) {
  await assertNotPayingStore(shop);
  const account = await prisma.account.create({ data: { name: shop.domain.replace(".myshopify.com", "") } });
  await prisma.shop.update({ where: { id: shop.id }, data: { accountId: account.id } });
  await logActivity(shop.id, { action: "shop.left_account", message: "Store moved to its own account." });
  return account;
}

/**
 * Shopify bills the store that approved the charge. If that store moved away,
 * the stores left behind kept a plan nobody was paying for, and the store
 * itself lost the plan it was still being charged for.
 */
async function assertNotPayingStore(shop: Pick<Shop, "id" | "accountId">) {
  if (!shop.accountId) return;
  const account = await prisma.account.findUnique({ where: { id: shop.accountId } });
  if (account && paysForAccountPlan(account, shop.id)) {
    const plan = isPlanId(account.plan) ? PLANS[account.plan].displayName : account.plan;
    throw new AccountLinkError(`This store pays for the account's ${plan} plan.`, "billing.stores.error.payingStore", { plan });
  }
}
