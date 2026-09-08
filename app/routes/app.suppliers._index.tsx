import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import type { SupplierPlatform } from "@prisma/client";
import { Badge, Banner, BlockStack, Box, Button, Card, Checkbox, InlineGrid, InlineStack, Layout, Page, Text, TextField } from "@shopify/polaris";
import { PlatformBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { encryptionConfigured } from "~/lib/crypto.server";
import { errorMessage } from "~/lib/errors";
import { env } from "~/lib/env.server";
import { formatDate, relativeTime } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
import { beginOAuth, connectSupplierAccount, createCredentiallessAccount, disconnectSupplierAccount, listSupplierAccounts, setDefaultSupplierAccount, testSupplierAccount } from "~/services/supplier-accounts.server";
import { listPlatforms } from "~/services/suppliers/index.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const [accounts, platforms] = await Promise.all([listSupplierAccounts(shop.id), listPlatforms()]);
  return {
    accounts,
    platforms,
    mockMode: env().SUPPLIER_DRIVER === "mock",
    encryption: encryptionConfigured(),
    connected: url.searchParams.get("connected"),
    oauthError: url.searchParams.get("error"),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { intent, get } = await readForm(request);
  const platform = get("platform") as SupplierPlatform;
  try {
    switch (intent) {
      case "oauth": {
        const { url } = await beginOAuth(shop.id, platform);
        return { ok: true, redirect: url };
      }
      case "apikey": {
        await connectSupplierAccount({ shopId: shop.id, platform, code: `${get("email")}:${get("apiKey")}`, label: get("label") || undefined, shareAcrossStores: get("share") === "true" });
        throw redirect("/app/suppliers?connected=1");
      }
      case "mock": {
        await createCredentiallessAccount(shop.id, "MOCK", get("label") || "Mock supplier");
        throw redirect("/app/suppliers?connected=1");
      }
      case "default":
        await setDefaultSupplierAccount(shop.id, get("id"));
        return { ok: true, messageKey: "msg.defaultAccountUpdated" };
      case "disconnect":
        await disconnectSupplierAccount(shop.id, get("id"));
        return { ok: true, messageKey: "msg.accountDisconnected" };
      case "test": {
        const result = await testSupplierAccount(shop.id, get("id"));
        return { ok: result.ok, message: result.ok ? result.message : undefined, error: result.ok ? undefined : result.message };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    if (e instanceof Response) throw e;
    return { ok: false, error: errorMessage(e) };
  }
};

export default function SuppliersPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string; redirect?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const [cj, setCj] = useState({ email: "", apiKey: "", label: "", share: true });
  const [mockLabel, setMockLabel] = useState("Mock supplier");

  // OAuth must leave the embedded iframe: open the supplier's consent page at
  // top level. In an effect keyed on the URL, not in the render body — a render
  // is not a user gesture, so the browser blocks the popup, and it re-fires on
  // every later re-render of the page.
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    const target = result?.redirect;
    if (!target || typeof window === "undefined") return;
    if (openedRef.current === target) return;
    openedRef.current = target;
    window.open(target, "_top");
  }, [result?.redirect]);

  return (
    <Page title={t("page.suppliers.title")} subtitle={t("page.suppliers.subtitle")}>
      <Layout>
        <Layout.Section>
          {data.connected && (
            <Banner tone="success">
              <p>{t("suppliers.connected")}</p>
            </Banner>
          )}
          {data.oauthError && (
            <Banner tone="critical" title={t("suppliers.connectionFailed")}>
              <p>{data.oauthError}</p>
            </Banner>
          )}
          {actionMessage && (
            <Banner tone="success">
              <p>{actionMessage}</p>
            </Banner>
          )}
          {result?.error && (
            <Banner tone="critical">
              <p>{result.error}</p>
            </Banner>
          )}
          {data.mockMode && (
            <Banner tone="info" title={t("suppliers.mockMode.title")}>
              <p>{t("suppliers.mockMode.body")}</p>
            </Banner>
          )}
          {!data.encryption && !data.mockMode && (
            <Banner tone="warning" title={t("suppliers.encryptionOff.title")}>
              <p>{t("suppliers.encryptionOff.body")}</p>
            </Banner>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("suppliers.connectedAccounts")}
              </Text>
              {data.accounts.length === 0 && (
                <Text as="p" tone="subdued">
                  {t("suppliers.empty")}
                </Text>
              )}
              {data.accounts.map((a) => (
                <Box key={a.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center">
                        <PlatformBadge platform={a.platform} />
                        <Text as="span" fontWeight="semibold">
                          {a.label}
                        </Text>
                        {a.isDefault && <Badge tone="success">{t("suppliers.default")}</Badge>}
                        {!a.isActive && <Badge tone="critical">{t("suppliers.inactive")}</Badge>}
                        {a.needsReauth && <Badge tone="critical">{t("suppliers.reconnectNeeded")}</Badge>}
                        <Badge>{a.scope}</Badge>
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        {a.externalUserId ? `ID ${a.externalUserId} · ` : ""}
                        {a.expiresAt ? `${t("suppliers.tokenExpires")} ${formatDate(a.expiresAt)} · ` : ""}
                        {a.lastUsedAt ? `${t("suppliers.lastUsed")} ${relativeTime(a.lastUsedAt)}` : t("suppliers.neverUsed")}
                        {a.storeRegisteredAt ? ` · ${t("suppliers.storeRegistered")}` : ""}
                      </Text>
                      {a.needsReauth && (
                        <Text as="p" tone="critical" variant="bodySm">
                          {t("suppliers.rejected")}
                          {a.lastErrorAt ? ` ${relativeTime(a.lastErrorAt)}` : ""}. {t("suppliers.rejectedHelp")}
                        </Text>
                      )}
                    </BlockStack>
                    <InlineStack gap="100">
                      {a.needsReauth && (
                        <Button size="slim" variant="primary" onClick={() => fetcher.submit({ intent: "oauth", platform: a.platform }, { method: "post" })}>
                          {t("action.reconnect")}
                        </Button>
                      )}
                      <Button size="slim" onClick={() => fetcher.submit({ intent: "test", id: a.id }, { method: "post" })} loading={fetcher.state !== "idle"}>
                        {t("action.test")}
                      </Button>
                      {!a.isDefault && (
                        <Button size="slim" onClick={() => fetcher.submit({ intent: "default", id: a.id }, { method: "post" })}>
                          {t("suppliers.makeDefault")}
                        </Button>
                      )}
                      <Button size="slim" tone="critical" onClick={() => fetcher.submit({ intent: "disconnect", id: a.id }, { method: "post" })}>
                        {t("suppliers.disconnect")}
                      </Button>
                    </InlineStack>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
            {data.platforms.map((p) => (
              <Card key={p.platform}>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      {p.displayName}
                    </Text>
                    <Badge tone={p.configured ? "success" : "attention"}>{p.configured ? t("suppliers.ready") : t("suppliers.needsApiKeys")}</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {p.description}
                  </Text>
                  <InlineStack gap="100" wrap>
                    {p.capabilities.search && <Badge>{t("action.search")}</Badge>}
                    {p.capabilities.imageSearch && <Badge>{t("suppliers.capability.imageSearch")}</Badge>}
                    {p.capabilities.placeOrder && <Badge>{t("suppliers.capability.placeOrder")}</Badge>}
                    {p.capabilities.tracking && <Badge>{t("suppliers.capability.tracking")}</Badge>}
                    {p.capabilities.shippingQuotes && <Badge>{t("suppliers.capability.shippingQuotes")}</Badge>}
                  </InlineStack>
                  {p.authMode === "oauth" && (
                    <Button variant="primary" disabled={!p.configured} onClick={() => fetcher.submit({ intent: "oauth", platform: p.platform }, { method: "post" })}>
                      {t("suppliers.connectWith")} {p.displayName}
                    </Button>
                  )}
                  {p.authMode === "apikey" && (
                    <BlockStack gap="200">
                      <TextField label={t("suppliers.accountEmail")} value={cj.email} onChange={(v) => setCj({ ...cj, email: v })} autoComplete="off" />
                      <TextField label={t("suppliers.apiKey")} type="password" value={cj.apiKey} onChange={(v) => setCj({ ...cj, apiKey: v })} autoComplete="off" />
                      <TextField label={t("suppliers.label")} value={cj.label} onChange={(v) => setCj({ ...cj, label: v })} autoComplete="off" placeholder={t("suppliers.labelPlaceholder")} />
                      <Checkbox label={t("suppliers.shareAcrossStores")} checked={cj.share} onChange={(v) => setCj({ ...cj, share: v })} />
                      <Button variant="primary" disabled={!cj.email || !cj.apiKey} onClick={() => fetcher.submit({ intent: "apikey", platform: p.platform, ...cj, share: String(cj.share) }, { method: "post" })}>
                        {t("action.connect")}
                      </Button>
                    </BlockStack>
                  )}
                  {p.authMode === "none" && (
                    <BlockStack gap="200">
                      <TextField label={t("suppliers.label")} value={mockLabel} onChange={setMockLabel} autoComplete="off" />
                      <Button onClick={() => fetcher.submit({ intent: "mock", platform: p.platform, label: mockLabel }, { method: "post" })}>{t("suppliers.addMockAccount")}</Button>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
