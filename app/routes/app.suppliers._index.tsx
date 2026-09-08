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
        return { ok: true, message: "Default account updated." };
      case "disconnect":
        await disconnectSupplierAccount(shop.id, get("id"));
        return { ok: true, message: "Account disconnected." };
      case "test": {
        const result = await testSupplierAccount(get("id"));
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
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string; redirect?: string } | undefined;
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
    <Page title="Suppliers" subtitle="Connect the accounts used to search catalogs and place orders.">
      <Layout>
        <Layout.Section>
          {data.connected && (
            <Banner tone="success">
              <p>Supplier account connected.</p>
            </Banner>
          )}
          {data.oauthError && (
            <Banner tone="critical" title="Connection failed">
              <p>{data.oauthError}</p>
            </Banner>
          )}
          {result?.message && (
            <Banner tone="success">
              <p>{result.message}</p>
            </Banner>
          )}
          {result?.error && (
            <Banner tone="critical">
              <p>{result.error}</p>
            </Banner>
          )}
          {data.mockMode && (
            <Banner tone="info" title="Mock supplier mode">
              <p>
                SUPPLIER_DRIVER=mock: every platform is served by the built-in sample catalog, orders complete automatically and tracking is generated. Set SUPPLIER_DRIVER=live plus the platform API keys to go live.
              </p>
            </Banner>
          )}
          {!data.encryption && !data.mockMode && (
            <Banner tone="warning" title="Token encryption is off">
              <p>Set ENCRYPTION_KEY (32 bytes, base64) so supplier tokens are encrypted at rest.</p>
            </Banner>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Connected accounts
              </Text>
              {data.accounts.length === 0 && (
                <Text as="p" tone="subdued">
                  No supplier account yet. Connect one below.
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
                        {a.isDefault && <Badge tone="success">Default</Badge>}
                        {!a.isActive && <Badge tone="critical">Inactive</Badge>}
                        {a.needsReauth && <Badge tone="critical">Reconnect needed</Badge>}
                        <Badge>{a.scope}</Badge>
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        {a.externalUserId ? `ID ${a.externalUserId} · ` : ""}
                        {a.expiresAt ? `token expires ${formatDate(a.expiresAt)} · ` : ""}
                        {a.lastUsedAt ? `last used ${relativeTime(a.lastUsedAt)}` : "never used"}
                        {a.storeRegisteredAt ? " · store registered" : ""}
                      </Text>
                      {a.needsReauth && (
                        <Text as="p" tone="critical" variant="bodySm">
                          The platform rejected this account{a.lastErrorAt ? ` ${relativeTime(a.lastErrorAt)}` : ""}. Orders will not be placed until you reconnect.
                        </Text>
                      )}
                    </BlockStack>
                    <InlineStack gap="100">
                      {a.needsReauth && (
                        <Button size="slim" variant="primary" onClick={() => fetcher.submit({ intent: "oauth", platform: a.platform }, { method: "post" })}>
                          Reconnect
                        </Button>
                      )}
                      <Button size="slim" onClick={() => fetcher.submit({ intent: "test", id: a.id }, { method: "post" })} loading={fetcher.state !== "idle"}>
                        Test
                      </Button>
                      {!a.isDefault && (
                        <Button size="slim" onClick={() => fetcher.submit({ intent: "default", id: a.id }, { method: "post" })}>
                          Make default
                        </Button>
                      )}
                      <Button size="slim" tone="critical" onClick={() => fetcher.submit({ intent: "disconnect", id: a.id }, { method: "post" })}>
                        Disconnect
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
                    <Badge tone={p.configured ? "success" : "attention"}>{p.configured ? "Ready" : "Needs API keys"}</Badge>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {p.description}
                  </Text>
                  <InlineStack gap="100" wrap>
                    {p.capabilities.search && <Badge>Search</Badge>}
                    {p.capabilities.imageSearch && <Badge>Image search</Badge>}
                    {p.capabilities.placeOrder && <Badge>Auto order</Badge>}
                    {p.capabilities.tracking && <Badge>Tracking</Badge>}
                    {p.capabilities.shippingQuotes && <Badge>Shipping quotes</Badge>}
                  </InlineStack>
                  {p.authMode === "oauth" && (
                    <Button variant="primary" disabled={!p.configured} onClick={() => fetcher.submit({ intent: "oauth", platform: p.platform }, { method: "post" })}>
                      Connect with {p.displayName}
                    </Button>
                  )}
                  {p.authMode === "apikey" && (
                    <BlockStack gap="200">
                      <TextField label="Account email" value={cj.email} onChange={(v) => setCj({ ...cj, email: v })} autoComplete="off" />
                      <TextField label="API key" type="password" value={cj.apiKey} onChange={(v) => setCj({ ...cj, apiKey: v })} autoComplete="off" />
                      <TextField label="Label" value={cj.label} onChange={(v) => setCj({ ...cj, label: v })} autoComplete="off" placeholder="Main CJ account" />
                      <Checkbox label="Share with all my stores" checked={cj.share} onChange={(v) => setCj({ ...cj, share: v })} />
                      <Button variant="primary" disabled={!cj.email || !cj.apiKey} onClick={() => fetcher.submit({ intent: "apikey", platform: p.platform, ...cj, share: String(cj.share) }, { method: "post" })}>
                        Connect
                      </Button>
                    </BlockStack>
                  )}
                  {p.authMode === "none" && (
                    <BlockStack gap="200">
                      <TextField label="Label" value={mockLabel} onChange={setMockLabel} autoComplete="off" />
                      <Button onClick={() => fetcher.submit({ intent: "mock", platform: p.platform, label: mockLabel }, { method: "post" })}>Add mock account</Button>
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
