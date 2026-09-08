import crypto from "node:crypto";
import type { Prisma, SupplierPlatform } from "@prisma/client";
import prisma from "~/db.server";
import { decryptSecret, encryptSecret } from "~/lib/crypto.server";
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
  const state = Buffer.from(JSON.stringify({ shopId, platform, nonce, ts: Date.now() })).toString("base64url");
  return { url: adapter.getAuthorizationUrl(state), state };
}

export function parseOAuthState(state: string): { shopId: string; platform: SupplierPlatform; nonce: string; ts: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    if (!parsed.shopId || !parsed.platform) return null;
    if (Date.now() - Number(parsed.ts) > 30 * 60_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** OAuth step 2 / API-key connect: exchange the code and store the account. */
export async function connectSupplierAccount(input: {
  shopId: string;
  platform: SupplierPlatform;
  code: string;
  label?: string;
  shareAcrossStores?: boolean;
}) {
  const shop = await prisma.shop.findUnique({ where: { id: input.shopId } });
  if (!shop) throw new Error("Shop not found");
  if (!shop.accountId) throw new Error("Shop has no parent account");

  const adapter = getAdapter(input.platform);
  let tokens: Awaited<ReturnType<NonNullable<typeof adapter.exchangeCode>>> | null = null;
  if (adapter.exchangeCode) {
    tokens = await adapter.exchangeCode(input.code);
  }

  const existingCount = await prisma.supplierAccount.count({ where: { accountId: shop.accountId, platform: input.platform } });
  const label = input.label?.trim() || tokens?.meta?.account?.toString() || tokens?.externalUserId || `${input.platform} account ${existingCount + 1}`;

  const account = await prisma.supplierAccount.create({
    data: {
      accountId: shop.accountId,
      shopId: input.shareAcrossStores ? null : input.shopId,
      platform: input.platform,
      label,
      externalUserId: tokens?.externalUserId ?? null,
      accessToken: encryptSecret(tokens?.accessToken ?? null),
      refreshToken: encryptSecret(tokens?.refreshToken ?? null),
      expiresAt: tokens?.expiresAt ?? null,
      meta: (tokens?.meta ?? {}) as Prisma.InputJsonValue,
      isDefault: existingCount === 0,
    },
  });

  // AliExpress requires the store to be registered with the dropshipping
  // programme before its order APIs work; best effort, reported if it fails.
  if (adapter.registerStore) {
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
    action: "supplier.connected",
    entity: "SupplierAccount",
    entityId: account.id,
    message: `${input.platform} account "${label}" connected.`,
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

export async function setDefaultSupplierAccount(shopId: string, id: string) {
  const target = await prisma.supplierAccount.findUnique({ where: { id } });
  if (!target) return;
  await prisma.$transaction([
    prisma.supplierAccount.updateMany({ where: { accountId: target.accountId, platform: target.platform, isDefault: true }, data: { isDefault: false } }),
    prisma.supplierAccount.update({ where: { id }, data: { isDefault: true } }),
  ]);
  await logActivity(shopId, { action: "supplier.default", entity: "SupplierAccount", entityId: id, message: `"${target.label}" is now the default ${target.platform} account.` });
}

export async function disconnectSupplierAccount(shopId: string, id: string) {
  const target = await prisma.supplierAccount.findUnique({ where: { id } });
  if (!target) return;
  await prisma.supplierAccount.delete({ where: { id } });
  await logActivity(shopId, { action: "supplier.disconnected", entity: "SupplierAccount", entityId: id, message: `${target.platform} account "${target.label}" disconnected.` });
}

export async function touchSupplierAccount(id: string) {
  await prisma.supplierAccount.update({ where: { id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
}

/** Health check used by the Suppliers page. */
export async function testSupplierAccount(id: string): Promise<{ ok: boolean; message: string }> {
  const account = await prisma.supplierAccount.findUnique({ where: { id } });
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
