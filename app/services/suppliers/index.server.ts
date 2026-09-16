import prisma from "~/db.server";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { env } from "~/lib/env.server";
import { SupplierError } from "~/lib/errors";
import { notify } from "../notifications.server";
import { logger } from "~/lib/logger.server";
import { AliExpressAdapter } from "./aliexpress.server";
import { CjDropshippingAdapter } from "./cj.server";
import { MockSupplierAdapter } from "./mock.server";
import type {
  PlaceOrderResult,
  SupplierAdapter,
  SupplierCredentials,
  SupplierOrderStatus,
  SupplierPlatform,
  SupplierProductDetail,
  SupplierSearchResult,
  SupplierShippingQuote,
  SupplierTracking,
} from "./types";

export interface PlatformInfo {
  platform: SupplierPlatform;
  displayName: string;
  description: string;
  authMode: "oauth" | "apikey" | "none";
  configured: boolean;
  capabilities: SupplierAdapter["capabilities"];
}

const mock = new MockSupplierAdapter();

/**
 * How ordering through the extension works, in the words every screen and
 * notification uses. The extension never places or pays for anything itself.
 */
export const EXTENSION_PLACEMENT_STEPS =
  "The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress. You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to Shopify.";

/** Error code for a platform this server cannot reach through an API. */
export const SUPPLIER_API_UNAVAILABLE = "SUPPLIER_API_UNAVAILABLE";

const PLATFORM_NAMES: Record<SupplierPlatform, string> = {
  ALIEXPRESS: "AliExpress",
  CJ_DROPSHIPPING: "CJ Dropshipping",
  TEMU: "Temu",
  MANUAL: "Manual supplier",
  MOCK: "Demo supplier",
};

/**
 * Stands in for a real platform the server has no API connection to.
 *
 * Every call fails with a reason the merchant can act on. This replaces the
 * old behaviour, where SUPPLIER_DRIVER=mock (and TEMU/MANUAL under any driver)
 * silently handed back the mock: a real AliExpress product captured by the
 * extension was then "ordered" through it, got a MOCK- order id and a fake
 * payment link, and invented tracking was pushed into a real Shopify
 * fulfilment that emailed the buyer. Nothing ever reached AliExpress.
 *
 * `getProduct` throws rather than returning null on purpose: null means "the
 * supplier removed this product", which marks every variant out of stock and
 * lets the inventory job unpublish a product that is perfectly fine.
 */
export class UnavailableSupplierAdapter implements SupplierAdapter {
  readonly displayName: string;
  readonly simulated = false;
  readonly capabilities = {
    search: false,
    imageSearch: false,
    oauth: false,
    placeOrder: false,
    cancelOrder: false,
    tracking: false,
    shippingQuotes: false,
  };

  constructor(readonly platform: SupplierPlatform) {
    this.displayName = PLATFORM_NAMES[platform];
  }

  isConfigured() {
    return false;
  }

  parseProductReference(input: string): string | null {
    // Recognising a link needs no API, and the extension's capture route relies
    // on it to file a product under the right platform.
    if (this.platform === "ALIEXPRESS") return new AliExpressAdapter().parseProductReference(input);
    if (this.platform === "CJ_DROPSHIPPING") return new CjDropshippingAdapter().parseProductReference(input);
    return null;
  }

  private refuse(): never {
    throw new SupplierError(SUPPLIER_API_UNAVAILABLE, unavailableReason(this.platform));
  }

  async searchProducts(): Promise<SupplierSearchResult> {
    return this.refuse();
  }

  async getProduct(): Promise<SupplierProductDetail | null> {
    return this.refuse();
  }

  async getShippingQuotes(): Promise<SupplierShippingQuote[]> {
    return this.refuse();
  }

  async placeOrder(): Promise<PlaceOrderResult> {
    return this.refuse();
  }

  async getOrder(): Promise<SupplierOrderStatus | null> {
    return this.refuse();
  }

  async getTracking(): Promise<SupplierTracking[]> {
    return this.refuse();
  }
}

/** What the merchant should do instead, for a platform with no API connection. */
export function unavailableReason(platform: SupplierPlatform): string {
  if (platform === "ALIEXPRESS") {
    return "AliExpress is not connected through its API on this server. Open the product on AliExpress and use the DropshipHub Chrome extension on that page to add it; supplier orders are placed from the extension too.";
  }
  return `${PLATFORM_NAMES[platform]} cannot be reached from DropshipHub yet. Place this order on the supplier's own site, then link its order id on the order page.`;
}

/**
 * Instantiate the adapter for a platform.
 *
 * The Demo supplier (MOCK) is served by the in-memory mock under any driver.
 * A real platform is served by its real adapter only under SUPPLIER_DRIVER=live;
 * otherwise, and for platforms with no integration at all, it gets an adapter
 * that refuses every call with a clear reason. The mock is never handed to a
 * real platform: whatever it answers is invented, and on a real platform that
 * invention reaches real merchants and buyers.
 */
export function getAdapter(platform: SupplierPlatform, credentials: SupplierCredentials = {}): SupplierAdapter {
  if (platform === "MOCK") return mock;
  if (env().SUPPLIER_DRIVER !== "live") return new UnavailableSupplierAdapter(platform);
  switch (platform) {
    case "ALIEXPRESS":
      return new AliExpressAdapter(credentials);
    case "CJ_DROPSHIPPING":
      return new CjDropshippingAdapter(credentials);
    case "MANUAL":
    case "TEMU":
    default:
      return new UnavailableSupplierAdapter(platform);
  }
}

// ---------------------------------------------------------------------------
// Placement mode
// ---------------------------------------------------------------------------

/**
 * How a supplier order for one platform gets placed for one shop.
 *
 * - `api`: the app places it upstream itself.
 * - `demo`: the Demo supplier simulates it (platform MOCK only).
 * - `extension`: the app prices it and holds it as AWAITING_PLACEMENT; the
 *   merchant's browser places it on the supplier's site through the extension.
 * - `unavailable`: nothing can place it; placement fails with the reason.
 */
export type PlacementMode = "api" | "demo" | "extension" | "unavailable";

/** Platforms the app has an ordering API integration for. */
const API_PLATFORMS = new Set<SupplierPlatform>(["ALIEXPRESS", "CJ_DROPSHIPPING"]);
/** Platforms the Chrome extension can place orders on. */
const EXTENSION_PLATFORMS = new Set<SupplierPlatform>(["ALIEXPRESS"]);

/**
 * The single rule for placement mode. Pure, so every combination is tested.
 *
 * "api" needs all three of: the live driver, server keys for the platform, and
 * a supplier account this shop has connected. Any one missing means an API
 * call would fail or - as happened under the mock driver - be answered by
 * something other than the supplier.
 */
export function decidePlacementMode(input: {
  platform: SupplierPlatform;
  driver: "mock" | "live";
  apiConfigured: boolean;
  hasConnectedAccount: boolean;
}): PlacementMode {
  if (input.platform === "MOCK") return "demo";
  if (input.driver === "live" && API_PLATFORMS.has(input.platform) && input.apiConfigured && input.hasConnectedAccount) {
    return "api";
  }
  return EXTENSION_PLATFORMS.has(input.platform) ? "extension" : "unavailable";
}

/** Placement mode for a shop, reading its connected supplier accounts. */
export async function placementModeForShop(shopId: string, platform: SupplierPlatform): Promise<PlacementMode> {
  if (platform === "MOCK") return "demo";
  const account = (await connectedAccountsFor(shopId, platform))[0] ?? null;
  let apiConfigured = false;
  if (platform === "ALIEXPRESS") apiConfigured = new AliExpressAdapter().isConfigured();
  // CJ authenticates per account with an API key, stored as its access token.
  if (platform === "CJ_DROPSHIPPING") apiConfigured = Boolean(account?.accessToken) || new CjDropshippingAdapter().isConfigured();
  return decidePlacementMode({ platform, driver: env().SUPPLIER_DRIVER, apiConfigured, hasConnectedAccount: Boolean(account) });
}

/** The product page on the supplier's own site, for the merchant to open. */
export function supplierProductUrl(platform: SupplierPlatform, externalProductId: string | null, storedUrl?: string | null): string | null {
  if (platform === "MOCK") return null;
  if (storedUrl && /^https:\/\//i.test(storedUrl)) return storedUrl;
  if (platform === "ALIEXPRESS" && externalProductId && /^\d{6,}$/.test(externalProductId)) {
    return `https://www.aliexpress.com/item/${externalProductId}.html`;
  }
  return null;
}

/**
 * The supplier platforms as the Suppliers and Search screens describe them.
 *
 * Each description has to be true on this server. AliExpress used to be
 * "Official Dropshipping API. Search, import, place orders and track
 * shipments." everywhere, including production, which runs the mock driver
 * with no AliExpress keys: there it can do none of that, and orders go through
 * the Chrome extension instead. So a platform only claims its API, and only
 * shows API capabilities, when the live driver and the server keys are both
 * present. `driver` and the configured flags are parameters so the rule is
 * tested for both servers.
 */
export function listPlatforms(
  input: { driver?: "mock" | "live"; aliexpressConfigured?: boolean; cjConfigured?: boolean } = {},
): PlatformInfo[] {
  const ali = new AliExpressAdapter();
  const cj = new CjDropshippingAdapter();
  const driver = input.driver ?? env().SUPPLIER_DRIVER;
  const aliConfigured = input.aliexpressConfigured ?? ali.isConfigured();
  const cjConfigured = input.cjConfigured ?? cj.isConfigured();
  const aliApi = driver === "live" && aliConfigured;
  const cjApi = driver === "live" && cjConfigured;
  return [
    {
      platform: "ALIEXPRESS",
      displayName: "AliExpress",
      description: aliApi
        ? "Official AliExpress Dropshipping API: search, import, place orders and track shipments once your AliExpress account is connected."
        : `Not connected through the AliExpress API on this server. Add products with the DropshipHub Chrome extension on the AliExpress product page. ${EXTENSION_PLACEMENT_STEPS}`,
      authMode: "oauth",
      // Only a platform that can really be connected reports itself configured;
      // keys under the mock driver would offer a Connect button that goes nowhere.
      configured: aliApi,
      capabilities: aliApi ? ali.capabilities : new UnavailableSupplierAdapter("ALIEXPRESS").capabilities,
    },
    {
      platform: "CJ_DROPSHIPPING",
      displayName: "CJ Dropshipping",
      description: cjApi
        ? "Warehouses in CN/US/EU, POD and branding services, through the CJ API once your CJ account is connected."
        : "Not connected on this server. CJ products cannot be searched, imported or ordered from DropshipHub yet.",
      authMode: "apikey",
      configured: cjApi,
      capabilities: cjApi ? cj.capabilities : new UnavailableSupplierAdapter("CJ_DROPSHIPPING").capabilities,
    },
    {
      platform: "MOCK",
      displayName: "Demo supplier",
      description: "Sample catalogue for trying the app. Products, prices and tracking are invented, and nothing is ever ordered.",
      authMode: "none",
      configured: true,
      capabilities: mock.capabilities,
    },
  ];
}

/** Adapter bound to a stored SupplierAccount, refreshing the token if needed. */
export async function adapterForAccount(accountId: string): Promise<{ adapter: SupplierAdapter; account: NonNullable<Awaited<ReturnType<typeof prisma.supplierAccount.findUnique>>> }> {
  const account = await prisma.supplierAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new SupplierError("SUPPLIER_ACCOUNT_MISSING", "Supplier account not found.");

  let accessToken = decryptSecret(account.accessToken);
  const refreshToken = decryptSecret(account.refreshToken);
  const meta = (account.meta ?? {}) as Record<string, unknown>;

  const expiringSoon = account.expiresAt && account.expiresAt.getTime() - Date.now() < 10 * 60_000;
  if (expiringSoon && refreshToken) {
    const fresh = getAdapter(account.platform, { accessToken, refreshToken, meta });
    if (fresh.refreshTokens) {
      try {
        const tokens = await fresh.refreshTokens(refreshToken);
        accessToken = tokens.accessToken;
        await prisma.supplierAccount.update({
          where: { id: account.id },
          data: {
            accessToken: encryptSecret(tokens.accessToken),
            refreshToken: encryptSecret(tokens.refreshToken ?? refreshToken),
            expiresAt: tokens.expiresAt ?? null,
          },
        });
      } catch (error) {
        logger.warn("Supplier token refresh failed", { accountId, error });
      }
    }
  }

  const adapter = getAdapter(account.platform, { accessToken, refreshToken, meta });
  return { adapter: watchAuth(adapter, account.id), account };
}

/**
 * Wrap an adapter so an authorisation failure marks the account as needing a
 * reconnect. Without this a merchant's expired AliExpress token would fail
 * every order individually with no obvious cause and no way back.
 */
function watchAuth(adapter: SupplierAdapter, accountId: string): SupplierAdapter {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          void noteAuthFailure(accountId, error);
          throw error;
        }
        if (result instanceof Promise) {
          return result.then(
            (ok) => {
              void clearAuthFailure(accountId);
              return ok;
            },
            (error) => {
              void noteAuthFailure(accountId, error);
              throw error;
            },
          );
        }
        return result;
      };
    },
  });
}

async function noteAuthFailure(accountId: string, error: unknown) {
  const code = error instanceof SupplierError ? error.code : null;
  if (code !== "SUPPLIER_NOT_AUTHORIZED") return;
  try {
    const account = await prisma.supplierAccount.update({
      where: { id: accountId },
      data: { needsReauth: true, lastErrorCode: code, lastErrorAt: new Date() },
      select: { id: true, label: true, platform: true, shopId: true, accountId: true },
    });
    const shop = account.shopId
      ? { id: account.shopId }
      : await prisma.shop.findFirst({ where: { accountId: account.accountId, isActive: true }, select: { id: true } });
    if (shop) {
      await notify(shop.id, {
        type: "supplier.auth",
        severity: "critical",
        title: `${account.platform} needs reconnecting`,
        body: `"${account.label}" was rejected by the platform. Orders will not be placed until you reconnect it.`,
        link: "/app/suppliers",
        dedupeKey: `reauth:${account.id}`,
        dedupeMinutes: 60 * 12,
      });
    }
  } catch (updateError) {
    logger.warn("Could not flag a supplier account for reauth", { accountId, error: updateError });
  }
}

async function clearAuthFailure(accountId: string) {
  try {
    await prisma.supplierAccount.updateMany({
      where: { id: accountId, needsReauth: true },
      data: { needsReauth: false, lastErrorCode: null },
    });
  } catch {
    // Best effort: a successful call should never fail because of bookkeeping.
  }
}

/**
 * Pick the supplier account a shop should use for a platform: the shop's own
 * default first, then any account on the parent Account, else a credential-less
 * adapter (live calls will raise NOT_AUTHORIZED; a platform with no API
 * connection refuses with the reason).
 */
export async function adapterForShop(shopId: string, platform: SupplierPlatform) {
  const candidates = await connectedAccountsFor(shopId, platform);
  const chosen = candidates[0];
  if (!chosen) return { adapter: getAdapter(platform), account: null };
  const { adapter, account } = await adapterForAccount(chosen.id);
  return { adapter, account };
}

/** A shop's usable supplier accounts for a platform, best first. */
async function connectedAccountsFor(shopId: string, platform: SupplierPlatform) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { accountId: true } });
  return prisma.supplierAccount.findMany({
    where: {
      platform,
      isActive: true,
      OR: [{ shopId }, ...(shop?.accountId ? [{ accountId: shop.accountId, shopId: null }] : [])],
    },
    // `nulls: "last"` matters: Postgres puts NULLs first on a DESC sort, so an
    // org-wide account (shopId null) would outrank the shop's own account and
    // the wrong supplier login would place the order.
    orderBy: [
      { isDefault: "desc" },
      { shopId: { sort: "desc", nulls: "last" } },
      { lastUsedAt: { sort: "desc", nulls: "last" } },
    ],
  });
}

/** Which platform a pasted URL or id belongs to. */
export function detectPlatform(reference: string): { platform: SupplierPlatform; externalId: string } | null {
  const trimmed = reference.trim();
  if (!trimmed) return null;
  const ali = new AliExpressAdapter().parseProductReference(trimmed);
  if (/aliexpress/i.test(trimmed) && ali) return { platform: "ALIEXPRESS", externalId: ali };
  const cj = new CjDropshippingAdapter().parseProductReference(trimmed);
  if (cj) return { platform: "CJ_DROPSHIPPING", externalId: cj };
  // A bare numeric id is treated as AliExpress regardless of driver, so the
  // same product resolves to one cached row whether pasted as URL or id.
  if (ali) return { platform: "ALIEXPRESS", externalId: ali };
  return null;
}
