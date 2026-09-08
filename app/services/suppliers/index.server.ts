import prisma from "~/db.server";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { env } from "~/lib/env.server";
import { SupplierError } from "~/lib/errors";
import { notify } from "../notifications.server";
import { logger } from "~/lib/logger.server";
import { AliExpressAdapter } from "./aliexpress.server";
import { CjDropshippingAdapter } from "./cj.server";
import { MockSupplierAdapter } from "./mock.server";
import type { SupplierAdapter, SupplierCredentials, SupplierPlatform } from "./types";

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
 * Instantiate the adapter for a platform. With SUPPLIER_DRIVER=mock every
 * platform is served by the in-memory mock, so the whole app can be exercised
 * without upstream credentials.
 */
export function getAdapter(platform: SupplierPlatform, credentials: SupplierCredentials = {}): SupplierAdapter {
  if (env().SUPPLIER_DRIVER === "mock" || platform === "MOCK") return mock;
  switch (platform) {
    case "ALIEXPRESS":
      return new AliExpressAdapter(credentials);
    case "CJ_DROPSHIPPING":
      return new CjDropshippingAdapter(credentials);
    case "MANUAL":
    case "TEMU":
    default:
      // Not yet integrated platforms behave like the mock so mappings and
      // orders still flow; the purchase order is left for manual placement.
      return mock;
  }
}

export function listPlatforms(): PlatformInfo[] {
  const mockMode = env().SUPPLIER_DRIVER === "mock";
  const ali = new AliExpressAdapter();
  const cj = new CjDropshippingAdapter();
  return [
    {
      platform: "ALIEXPRESS",
      displayName: "AliExpress",
      description: "Official Dropshipping API. Search, import, place orders and track shipments.",
      authMode: "oauth",
      configured: mockMode || ali.isConfigured(),
      capabilities: ali.capabilities,
    },
    {
      platform: "CJ_DROPSHIPPING",
      displayName: "CJ Dropshipping",
      description: "Warehouses in CN/US/EU, POD and branding services.",
      authMode: "apikey",
      configured: mockMode || cj.isConfigured(),
      capabilities: cj.capabilities,
    },
    {
      platform: "MOCK",
      displayName: "Mock supplier",
      description: "Sample catalog for testing the full flow without credentials.",
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
 * adapter (fine for search in mock mode; live calls will raise NOT_AUTHORIZED).
 */
export async function adapterForShop(shopId: string, platform: SupplierPlatform) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { accountId: true } });
  const candidates = await prisma.supplierAccount.findMany({
    where: {
      platform,
      isActive: true,
      OR: [{ shopId }, ...(shop?.accountId ? [{ accountId: shop.accountId, shopId: null }] : [])],
    },
    orderBy: [{ isDefault: "desc" }, { shopId: "desc" }, { lastUsedAt: "desc" }],
  });
  const chosen = candidates[0];
  if (!chosen) return { adapter: getAdapter(platform), account: null };
  const { adapter, account } = await adapterForAccount(chosen.id);
  return { adapter, account };
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
