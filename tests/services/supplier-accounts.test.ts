/**
 * The supplier OAuth state and the connection it completes.
 *
 * The callback is an unauthenticated GET, so the signed state is the only thing
 * tying a returning supplier to a shop. It has to tell "forged" (trust nothing)
 * from "ours, but old" (send that shop back to start again), and a callback that
 * arrives twice must not report a failure, or add a second connection, for an
 * account that was connected by the first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    shop: { findUnique: vi.fn() },
    supplierAccount: { findFirst: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
  exchangeCode: vi.fn(),
  registerStore: vi.fn(),
  logActivity: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("~/db.server", () => ({ default: mocks.prisma }));
vi.mock("~/lib/env.server", () => ({ env: () => ({ SHOPIFY_API_SECRET: "shpss_test_secret" }) }));
vi.mock("~/lib/crypto.server", () => ({ encryptSecret: (value: string | null) => (value ? `enc:${value}` : null), decryptSecret: (value: string | null) => value }));
vi.mock("~/services/activity.server", () => ({ logActivity: mocks.logActivity }));
vi.mock("~/services/notifications.server", () => ({ notify: mocks.notify }));
vi.mock("~/services/suppliers/index.server", () => ({
  getAdapter: () => ({
    getAuthorizationUrl: (state: string) => `https://auth.example.com/authorize?state=${state}`,
    exchangeCode: mocks.exchangeCode,
    registerStore: mocks.registerStore,
  }),
}));

const { beginOAuth, connectSupplierAccount, parseOAuthState, verifyOAuthState, OAUTH_STATE_TTL_MS } = await import("~/services/supplier-accounts.server");

const SHOP = { id: "shop_1", accountId: "acct_1", domain: "demo.myshopify.com" };

beforeEach(() => {
  for (const group of [mocks.prisma.shop, mocks.prisma.supplierAccount]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  mocks.exchangeCode.mockReset();
  mocks.registerStore.mockReset().mockResolvedValue(true);
  mocks.logActivity.mockReset();
  mocks.notify.mockReset();
  mocks.prisma.shop.findUnique.mockResolvedValue(SHOP);
});

describe("verifyOAuthState", () => {
  it("accepts a fresh state it signed", async () => {
    const { state } = await beginOAuth(SHOP.id, "ALIEXPRESS");
    const check = verifyOAuthState(state);
    expect(check.status).toBe("valid");
    expect(check.status !== "invalid" && check.payload.shopId).toBe(SHOP.id);
    expect(parseOAuthState(state)?.platform).toBe("ALIEXPRESS");
  });

  it("reports an authentic state past its lifetime as expired, still naming its shop", async () => {
    const { state } = await beginOAuth(SHOP.id, "ALIEXPRESS");
    const check = verifyOAuthState(state, Date.now() + OAUTH_STATE_TTL_MS + 1000);
    expect(check).toMatchObject({ status: "expired", payload: { shopId: SHOP.id, platform: "ALIEXPRESS" } });
  });

  it("never lets parseOAuthState hand out an expired state", async () => {
    const { state } = await beginOAuth(SHOP.id, "ALIEXPRESS");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + OAUTH_STATE_TTL_MS + 1000);
    try {
      expect(parseOAuthState(state)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a payload rewritten to name another shop as invalid, even when it is also old", async () => {
    const { state } = await beginOAuth(SHOP.id, "ALIEXPRESS");
    const [, signature] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ shopId: "victim_shop", platform: "ALIEXPRESS", nonce: "x", ts: 0 })).toString("base64url");
    expect(verifyOAuthState(`${forged}.${signature}`)).toEqual({ status: "invalid" });
  });

  it("treats a wrong signature, a missing signature and garbage as invalid", async () => {
    const { state } = await beginOAuth(SHOP.id, "ALIEXPRESS");
    const [payload] = state.split(".");
    expect(verifyOAuthState(`${payload}.AAAA`)).toEqual({ status: "invalid" });
    expect(verifyOAuthState(payload)).toEqual({ status: "invalid" });
    expect(verifyOAuthState(`${state}.extra`)).toEqual({ status: "invalid" });
    expect(verifyOAuthState("")).toEqual({ status: "invalid" });
  });
});

describe("connectSupplierAccount", () => {
  it("answers a replayed callback with the account the first one created, without exchanging the used code", async () => {
    const connected = { id: "sa_1", label: "buyer-1", storeRegisteredAt: new Date() };
    mocks.prisma.supplierAccount.findFirst.mockResolvedValueOnce(connected);

    const result = await connectSupplierAccount({ shopId: SHOP.id, platform: "ALIEXPRESS", code: "used-code", shareAcrossStores: true, oauthNonce: "nonce-1" });

    expect(result).toBe(connected);
    // The nonce lives in the account's meta JSON; this is the exact Postgres JSON path filter.
    expect(mocks.prisma.supplierAccount.findFirst).toHaveBeenCalledWith({
      where: { accountId: SHOP.accountId, platform: "ALIEXPRESS", meta: { path: ["oauthNonce"], equals: "nonce-1" } },
    });
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.prisma.supplierAccount.create).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("creates the account on a first callback and records the nonce that makes a replay harmless", async () => {
    mocks.prisma.supplierAccount.findFirst.mockResolvedValue(null);
    mocks.prisma.supplierAccount.count.mockResolvedValue(0);
    mocks.exchangeCode.mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresAt: null, externalUserId: "buyer-1", meta: { region: "SG" } });
    mocks.prisma.supplierAccount.create.mockImplementation(async ({ data }) => ({ id: "sa_new", storeRegisteredAt: null, ...data }));

    await connectSupplierAccount({ shopId: SHOP.id, platform: "ALIEXPRESS", code: "fresh", shareAcrossStores: true, oauthNonce: "nonce-2" });

    expect(mocks.prisma.supplierAccount.findFirst).toHaveBeenNthCalledWith(2, {
      where: { accountId: SHOP.accountId, platform: "ALIEXPRESS", externalUserId: "buyer-1" },
    });
    expect(mocks.prisma.supplierAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: SHOP.accountId,
        shopId: null,
        externalUserId: "buyer-1",
        accessToken: "enc:at",
        meta: { region: "SG", oauthNonce: "nonce-2" },
        isDefault: true,
      }),
    });
    expect(mocks.registerStore).toHaveBeenCalledWith("https://demo.myshopify.com");
  });

  it("refreshes the existing row when the same supplier user connects again, instead of adding a duplicate", async () => {
    const existing = { id: "sa_1", label: "My AliExpress", storeRegisteredAt: new Date(), needsReauth: true };
    mocks.prisma.supplierAccount.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    mocks.exchangeCode.mockResolvedValue({ accessToken: "at2", refreshToken: "rt2", expiresAt: null, externalUserId: "buyer-1", meta: {} });
    mocks.prisma.supplierAccount.update.mockImplementation(async ({ data }) => ({ ...existing, ...data }));

    await connectSupplierAccount({ shopId: SHOP.id, platform: "ALIEXPRESS", code: "again", shareAcrossStores: true, oauthNonce: "nonce-3" });

    expect(mocks.prisma.supplierAccount.create).not.toHaveBeenCalled();
    expect(mocks.prisma.supplierAccount.update).toHaveBeenCalledWith({
      where: { id: "sa_1" },
      data: expect.objectContaining({ accessToken: "enc:at2", label: "My AliExpress", needsReauth: false, lastErrorCode: null, meta: { oauthNonce: "nonce-3" } }),
    });
    // Already registered with the dropshipping programme; no second registration call.
    expect(mocks.registerStore).not.toHaveBeenCalled();
    expect(mocks.logActivity).toHaveBeenCalledWith(SHOP.id, expect.objectContaining({ action: "supplier.reconnected" }));
  });

  it("skips the replay lookup entirely for an API-key connect that has no OAuth state", async () => {
    mocks.prisma.supplierAccount.findFirst.mockResolvedValue(null);
    mocks.prisma.supplierAccount.count.mockResolvedValue(1);
    mocks.exchangeCode.mockResolvedValue({ accessToken: "at", refreshToken: null, expiresAt: null, externalUserId: "me@example.com", meta: {} });
    mocks.prisma.supplierAccount.create.mockImplementation(async ({ data }) => ({ id: "sa_cj", storeRegisteredAt: null, ...data }));

    await connectSupplierAccount({ shopId: SHOP.id, platform: "CJ_DROPSHIPPING", code: "me@example.com:key" });

    expect(mocks.prisma.supplierAccount.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.supplierAccount.findFirst).toHaveBeenCalledWith({ where: { accountId: SHOP.accountId, platform: "CJ_DROPSHIPPING", externalUserId: "me@example.com" } });
    expect(mocks.prisma.supplierAccount.create).toHaveBeenCalledWith({ data: expect.objectContaining({ meta: {}, isDefault: false, shopId: SHOP.id }) });
  });
});
