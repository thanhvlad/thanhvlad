import crypto from "node:crypto";
import type { Prisma, SupplierPlatform } from "@prisma/client";
import prisma from "~/db.server";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
import { env } from "~/lib/env.server";
import { SupplierError } from "~/lib/errors";
import { logActivity } from "./activity.server";
import { notify } from "./notifications.server";
import { getAdapter } from "./suppliers/index.server";

export async function listSupplierAccounts(shopId: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { accountId: true } });
  const rows = await prisma.supplierAccount.findMany({
    where: { OR: [{ shopId }, ...(shop?.accountId ? [{ accountId: shop.accountId }] : [])] },
    orderBy: [{ platform: "asc" }, { isDefault: "desc" }, { createdAt: "asc" }],
    include: { shop: { select: { domain: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    label: r.label,
    externalUserId: r.externalUserId,
    isDefault: r.isDefault,
    isActive: r.isActive,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    needsReauth: r.needsReauth,
    lastErrorAt: r.lastErrorAt,
    storeRegisteredAt: r.storeRegisteredAt,
    scope: r.shopId ? (r.shop?.domain ?? "this store") : "all stores",
    hasToken: Boolean(r.accessToken),
    createdAt: r.createdAt,
  }));
}

/**
 * OAuth step 1. The state carries the shop id and a nonce; it is verified in
 * `completeOAuth` before any token is stored.
 */
export async function beginOAuth(shopId: string, platform: SupplierPlatform): Promise<{ url: string; state: string }> {
  const adapter = getAdapter(platform);
  if (!adapter.getAuthorizationUrl) {
    throw new SupplierError("SUPPLIER_NO_OAUTH", `${platform} does not use OAuth.`);
  }
  const nonce = crypto.randomBytes(12).toString("hex");
  const payload = Buffer.from(JSON.stringify({ shopId, platform, nonce, ts: Date.now() })).toString("base64url");
  const state = `${payload}.${signState(payload)}`;
  return { url: adapter.getAuthorizationUrl(state), state };
}

/**
 * Sign the OAuth state.
 *
 * The callback is an unauthenticated GET, and the state is the only thing
 * saying which shop the returning token belongs to. Unsigned, anyone could hand
 * the callback a state naming a shop that is not theirs and bind a supplier
 * connection — or their own token — to it.
 */
function signState(payload: string): string {
  return crypto.createHmac("sha256", stateSecret()).update(payload).digest("base64url");
}

function stateSecret(): string {
  const config = env();
  // The app's own client secret is already required, already secret, and stable
  // across restarts and instances.
  return config.SHOPIFY_API_SECRET || config.ENCRYPTION_KEY || "";
}

export interface OAuthStatePayload {
  shopId: string;
  platform: SupplierPlatform;
  nonce: string;
  ts: number;
}

/** How long a merchant has between starting a connection and the supplier sending them back. */
export const OAUTH_STATE_TTL_MS = 30 * 60_000;

/**
 * What a returned OAuth state proves.
 *
 * `invalid` means the signature does not verify (or the state is malformed), so
 * nothing in it can be trusted, least of all the shop it names. `expired` means
 * the app did sign it, for that shop, but longer ago than the TTL: the shop is
 * known, so the callback can send the merchant back into their own admin to
 * start again, but the connection itself must not be completed. Before this
 * split both cases looked the same and an expired return was stranded on a
 * static page that could only point at admin.shopify.com.
 */
export type OAuthStateCheck =
  | { status: "valid"; payload: OAuthStatePayload }
  | { status: "expired"; payload: OAuthStatePayload }
  | { status: "invalid" };

export function verifyOAuthState(state: string, now: number = Date.now()): OAuthStateCheck {
  try {
    const [payload, signature, extra] = state.split(".");
    if (!payload || !signature || extra !== undefined) return { status: "invalid" };
    const expected = signState(payload);
    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      return { status: "invalid" };
    }
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed?.shopId !== "string" || !parsed.shopId || typeof parsed.platform !== "string" || !parsed.platform) {
      return { status: "invalid" };
    }
    const ts = Number(parsed.ts);
    if (!Number.isFinite(ts)) return { status: "invalid" };
    const decoded: OAuthStatePayload = { shopId: parsed.shopId, platform: parsed.platform as SupplierPlatform, nonce: String(parsed.nonce ?? ""), ts };
    if (now - ts > OAUTH_STATE_TTL_MS) return { status: "expired", payload: decoded };
    return { status: "valid", payload: decoded };
  } catch {
    return { status: "invalid" };
  }
}

/** The payload of a state that is both authentic and fresh; null otherwise. */
export function parseOAuthState(state: string): OAuthStatePayload | null {
  const check = verifyOAuthState(state);
  return check.status === "valid" ? check.payload : null;
}

/**
 * OAuth step 2 / API-key connect: exchange the code and store the account.
 *
 * Safe to call twice for the same return. A merchant who refreshes the callback
 * page, or a browser that replays the redirect, used to exchange an authorization
 * code the supplier had already consumed: the exchange failed and the merchant
 * was told the connection did not work, although it had. Now a return whose
 * state nonce is already recorded on an account answers with that account and
 * calls nothing upstream, and a fresh exchange that comes back for a supplier
 * user this account already has refreshes that row's tokens instead of adding a
 * second connection for the same person.
 */
export async function connectSupplierAccount(input: {
  shopId: string;
  platform: SupplierPlatform;
  code: string;
  label?: string;
  shareAcrossStores?: boolean;
  /** The nonce from the verified OAuth state, which makes a replayed return a no-op. */
  oauthNonce?: string;
}) {
  const shop = await prisma.shop.findUnique({ where: { id: input.shopId } });
  if (!shop) throw new Error("Shop not found");
  if (!shop.accountId) throw new Error("Shop has no parent account");

  if (input.oauthNonce) {
    const replayed = await prisma.supplierAccount.findFirst({
      where: { accountId: shop.accountId, platform: input.platform, meta: { path: ["oauthNonce"], equals: input.oauthNonce } },
    });
    if (replayed) return replayed;
  }

  const adapter = getAdapter(input.platform);
  let tokens: Awaited<ReturnType<NonNullable<typeof adapter.exchangeCode>>> | null = null;
  if (adapter.exchangeCode) {
    tokens = await adapter.exchangeCode(input.code);
  }

  const meta = { ...(tokens?.meta ?? {}), ...(input.oauthNonce ? { oauthNonce: input.oauthNonce } : {}) } as Prisma.InputJsonValue;
  const tokenFields = {
    accessToken: encryptSecret(tokens?.accessToken ?? null),
    refreshToken: encryptSecret(tokens?.refreshToken ?? null),
    expiresAt: tokens?.expiresAt ?? null,
    meta,
  };

  const existing = tokens?.externalUserId
    ? await prisma.supplierAccount.findFirst({
        where: { accountId: shop.accountId, platform: input.platform, externalUserId: tokens.externalUserId },
      })
    : null;

  const existingCount = existing ? 0 : await prisma.supplierAccount.count({ where: { accountId: shop.accountId, platform: input.platform } });
  const label =
    input.label?.trim() || existing?.label || tokens?.meta?.account?.toString() || tokens?.externalUserId || `${input.platform} account ${existingCount + 1}`;

  const account = existing
    ? await prisma.supplierAccount.update({
        where: { id: existing.id },
        // A reconnect is how a merchant fixes "Reconnect needed", so it clears the
        // error state. Scope and default flag stay as the merchant set them.
        data: { ...tokenFields, label, isActive: true, needsReauth: false, lastErrorCode: null, lastErrorAt: null },
      })
    : await prisma.supplierAccount.create({
        data: {
          accountId: shop.accountId,
          shopId: input.shareAcrossStores ? null : input.shopId,
          platform: input.platform,
          label,
          externalUserId: tokens?.externalUserId ?? null,
          ...tokenFields,
          isDefault: existingCount === 0,
        },
      });

  // AliExpress requires the store to be registered with the dropshipping
  // programme before its order APIs work; best effort, reported if it fails.
  if (adapter.registerStore && !account.storeRegisteredAt) {
    try {
      await adapter.registerStore(`https://${shop.domain}`);
      await prisma.supplierAccount.update({ where: { id: account.id }, data: { storeRegisteredAt: new Date() } });
    } catch (error) {
      await logActivity(input.shopId, {
        action: "supplier.register_store_failed",
        level: "warn",
        entity: "SupplierAccount",
        entityId: account.id,
        message: `Could not register the store with ${input.platform}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  await logActivity(input.shopId, {
    action: existing ? "supplier.reconnected" : "supplier.connected",
    entity: "SupplierAccount",
    entityId: account.id,
    message: existing ? `${input.platform} account "${label}" reconnected.` : `${input.platform} account "${label}" connected.`,
  });
  await notify(input.shopId, {
    type: "supplier.auth",
    title: `${input.platform} connected`,
    body: `"${label}" is ready to place orders.`,
  });
  return account;
}

/** For platforms with no auth at all (mock / manual). */
export async function createCredentiallessAccount(shopId: string, platform: SupplierPlatform, label: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop?.accountId) throw new Error("Shop has no parent account");
  const count = await prisma.supplierAccount.count({ where: { accountId: shop.accountId, platform } });
  return prisma.supplierAccount.create({
    data: { accountId: shop.accountId, shopId, platform, label, isDefault: count === 0 },
  });
}

/**
 * A supplier account reachable from this shop.
 *
 * The account id arrives from a form field, so every mutation is scoped: by
 * primary key alone another organisation's OAuth connection could be made
 * default, tested with their token, or deleted outright.
 */
async function ownedSupplierAccount(shopId: string, id: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { accountId: true } });
  return prisma.supplierAccount.findFirst({
    where: { id, OR: [{ shopId }, ...(shop?.accountId ? [{ accountId: shop.accountId }] : [])] },
  });
}

export async function setDefaultSupplierAccount(shopId: string, id: string) {
  const target = await ownedSupplierAccount(shopId, id);
  if (!target) return;
  await prisma.$transaction([
    prisma.supplierAccount.updateMany({ where: { accountId: target.accountId, platform: target.platform, isDefault: true }, data: { isDefault: false } }),
    prisma.supplierAccount.update({ where: { id }, data: { isDefault: true } }),
  ]);
  await logActivity(shopId, { action: "supplier.default", entity: "SupplierAccount", entityId: id, message: `"${target.label}" is now the default ${target.platform} account.` });
}

export async function disconnectSupplierAccount(shopId: string, id: string) {
  const target = await ownedSupplierAccount(shopId, id);
  if (!target) return;
  await prisma.supplierAccount.delete({ where: { id } });
  await logActivity(shopId, { action: "supplier.disconnected", entity: "SupplierAccount", entityId: id, message: `${target.platform} account "${target.label}" disconnected.` });
}

export async function touchSupplierAccount(id: string) {
  await prisma.supplierAccount.update({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
}

/** Health check used by the Suppliers page. */
export async function testSupplierAccount(shopId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const account = await ownedSupplierAccount(shopId, id);
  if (!account) return { ok: false, message: "Account not found" };
  const adapter = getAdapter(account.platform, {
    accessToken: decryptSecret(account.accessToken),
    refreshToken: decryptSecret(account.refreshToken),
    meta: (account.meta ?? {}) as Record<string, unknown>,
  });
  if (!adapter.isConfigured()) return { ok: false, message: "Platform API keys are not configured on the server." };
  try {
    // An empty query uses the platform's own feed, which every connected
    // account can read — keyword search additionally needs an affiliate id.
    const result = await adapter.searchProducts({ query: "", pageSize: 1 });
    await prisma.supplierAccount.update({ where: { id }, data: { needsReauth: false, lastErrorCode: null } });
    return { ok: true, message: `Connected. The catalog returned ${result.items.length} result(s).` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
