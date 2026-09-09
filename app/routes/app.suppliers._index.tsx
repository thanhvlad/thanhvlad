import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import type { SupplierPlatform } from "@prisma/client";
import { Badge, Banner, BlockStack, Box, Button, ButtonGroup, Card, Checkbox, Divider, FormLayout, InlineGrid, InlineStack, Layout, List, Modal, Page, Select, Text, TextField } from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { Stat } from "~/components/Stat";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { encryptionConfigured } from "~/lib/crypto.server";
import { errorMessage } from "~/lib/errors";
import { env } from "~/lib/env.server";
import { formatDate, relativeTime } from "~/lib/format";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
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
  const { shop } = await requireShop(request, { minRole: "ADMIN" });
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
        await createCredentiallessAccount(shop.id, "MOCK", get("label") || "Demo supplier");
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

type Account = SerializeFrom<typeof loader>["accounts"][number];

export default function SuppliersPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string; redirect?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const errorText = useErrorMessage(result);

  // Which button is busy: the fetcher carries the form it is sending, so a
  // "Test" on one account does not spin every button on every card.
  const busy = fetcher.state !== "idle";
  const pending = (intent: string, match?: Record<string, string>) =>
    busy && fetcher.formData?.get("intent") === intent && Object.entries(match ?? {}).every(([k, v]) => fetcher.formData?.get(k) === v);

  // Add-supplier modal.
  const [adding, setAdding] = useState(false);
  const [platform, setPlatform] = useState<string>(data.platforms[0]?.platform ?? "");
  const [cj, setCj] = useState({ email: "", apiKey: "", label: "", share: true });
  const [mockLabel, setMockLabel] = useState("Demo supplier");
  // Set while a submit from the modal is in flight, so its failure is shown
  // inside the modal (which stays open) instead of behind it.
  const [modalIntent, setModalIntent] = useState<string | null>(null);
  const openAdd = () => setAdding(true);
  const closeAdd = () => {
    setAdding(false);
    setModalIntent(null);
  };

  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    if (modalIntent && !result?.error) {
      setAdding(false);
      setModalIntent(null);
    }
  }, [busy, modalIntent, result?.error]);

  // Disconnect confirmation.
  const [disconnecting, setDisconnecting] = useState<Account | null>(null);

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

  const selected = data.platforms.find((p) => p.platform === platform) ?? data.platforms[0];
  const working = data.accounts.filter((a) => a.isActive && !a.needsReauth).length;
  const attention = data.accounts.length - working;
  const ready = data.platforms.filter((p) => p.configured).length;

  const submitFromModal = (intent: string, fields: Record<string, string>) => {
    setModalIntent(intent);
    fetcher.submit({ intent, ...fields }, { method: "post" });
  };
  const modalPrimary = !selected
    ? undefined
    : selected.authMode === "oauth"
      ? { content: `${t("suppliers.connectWith")} ${selected.displayName}`, disabled: !selected.configured, loading: pending("oauth", { platform: selected.platform }), onAction: () => submitFromModal("oauth", { platform: selected.platform }) }
      : selected.authMode === "apikey"
        ? { content: t("action.connect"), disabled: !cj.email || !cj.apiKey, loading: pending("apikey"), onAction: () => submitFromModal("apikey", { platform: selected.platform, ...cj, share: String(cj.share) }) }
        : { content: t("suppliers.addMockAccount"), loading: pending("mock"), onAction: () => submitFromModal("mock", { platform: selected.platform, label: mockLabel }) };

  return (
    <Page fullWidth title={t("page.suppliers.title")} subtitle={t("page.suppliers.subtitle")} primaryAction={{ content: t("suppliers.addSupplier"), onAction: openAdd }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
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
            {errorText && !modalIntent && (
              <Banner tone="critical">
                <p>{errorText}</p>
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
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
            <Stat label={t("suppliers.stat.connected")} value={String(working)} />
            <Stat label={t("suppliers.stat.attention")} value={String(attention)} tone={attention > 0 ? "critical" : "subdued"} hint={attention > 0 ? t("suppliers.stat.attentionHint") : t("suppliers.stat.allGood")} />
            <Stat label={t("suppliers.stat.platforms")} value={String(ready)} hint={t("suppliers.stat.platformsHint", { ready, total: data.platforms.length })} />
          </InlineGrid>
        </Layout.Section>

        {data.accounts.length === 0 && (
          <Layout.Section>
            <EmptyScreen heading={t("suppliers.emptyState.heading")} body={t("suppliers.emptyState.body")} action={{ content: t("suppliers.addSupplier"), onAction: openAdd }} />
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2, lg: 3 }} gap="400">
            {data.accounts.map((a) => (
              <Card key={a.id}>
                <BlockStack gap="300">
                  <BlockStack gap="150">
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <PlatformBadge platform={a.platform} />
                      <Text as="h3" variant="headingMd">
                        {a.label}
                      </Text>
                    </InlineStack>
                    <InlineStack gap="100" wrap>
                      <StatusBadge
                        status={a.needsReauth ? "FAILED" : a.isActive ? "ACTIVE" : "DISABLED"}
                        label={a.needsReauth ? t("suppliers.reconnectNeeded") : a.isActive ? t("suppliers.card.status.connected") : t("suppliers.card.status.inactive")}
                      />
                      {a.isDefault && <Badge tone="success">{t("suppliers.default")}</Badge>}
                    </InlineStack>
                  </BlockStack>

                  {a.needsReauth && (
                    <Banner tone="critical">
                      <p>
                        {t("suppliers.rejected")}
                        {a.lastErrorAt ? ` ${relativeTime(a.lastErrorAt)}` : ""}. {t("suppliers.rejectedHelp")}
                      </p>
                    </Banner>
                  )}

                  <Divider />
                  <BlockStack gap="100">
                    <Detail label={t("suppliers.card.lastUsed")} value={a.lastUsedAt ? relativeTime(a.lastUsedAt) : t("suppliers.neverUsed")} />
                    {a.expiresAt && <Detail label={t("suppliers.card.tokenExpires")} value={formatDate(a.expiresAt)} />}
                    {a.externalUserId && <Detail label={t("suppliers.card.accountId")} value={a.externalUserId} />}
                    {/* The service reports scope as "all stores", "this store"
                        or a shop domain; only the first two are ours to translate. */}
                    <Detail label={t("suppliers.card.scope")} value={a.scope === "all stores" ? t("suppliers.card.scope.allStores") : a.scope === "this store" ? t("suppliers.card.scope.thisStore") : a.scope} />
                    {a.storeRegisteredAt && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        {t("suppliers.card.storeRegistered")}
                      </Text>
                    )}
                  </BlockStack>

                  <ButtonGroup>
                    {a.needsReauth && (
                      <Button size="slim" variant="primary" loading={pending("oauth", { platform: a.platform })} onClick={() => fetcher.submit({ intent: "oauth", platform: a.platform }, { method: "post" })}>
                        {t("action.reconnect")}
                      </Button>
                    )}
                    <Button size="slim" loading={pending("test", { id: a.id })} onClick={() => fetcher.submit({ intent: "test", id: a.id }, { method: "post" })}>
                      {t("action.test")}
                    </Button>
                    {!a.isDefault && (
                      <Button size="slim" loading={pending("default", { id: a.id })} onClick={() => fetcher.submit({ intent: "default", id: a.id }, { method: "post" })}>
                        {t("suppliers.makeDefault")}
                      </Button>
                    )}
                    <Button size="slim" tone="critical" loading={pending("disconnect", { id: a.id })} onClick={() => setDisconnecting(a)}>
                      {t("suppliers.disconnect")}
                    </Button>
                  </ButtonGroup>
                </BlockStack>
              </Card>
            ))}

            {data.accounts.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {t("suppliers.addCard.title")}
                  </Text>
                  <Text as="p" tone="subdued">
                    {t("suppliers.addCard.body")}
                  </Text>
                  <InlineStack gap="100" wrap>
                    {data.platforms.map((p) => (
                      <Badge key={p.platform} tone={p.configured ? "success" : "attention"}>
                        {p.displayName}
                      </Badge>
                    ))}
                  </InlineStack>
                  <Box>
                    <Button onClick={openAdd}>{t("suppliers.addSupplier")}</Button>
                  </Box>
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h3" variant="headingMd">
                    {t("suppliers.extension.title")}
                  </Text>
                  <Badge tone="info">{t("suppliers.extension.badge")}</Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  {t("suppliers.extension.body")}
                </Text>
                <List type="number">
                  <List.Item>{t("suppliers.extension.step1")}</List.Item>
                  <List.Item>{t("suppliers.extension.step2")}</List.Item>
                  <List.Item>{t("suppliers.extension.step3")}</List.Item>
                </List>
                <Link to="/app/settings/advanced">{t("suppliers.extension.settingsLink")}</Link>
              </BlockStack>
            </Card>
          </InlineGrid>
        </Layout.Section>
      </Layout>

      <Modal open={adding} onClose={closeAdd} title={t("suppliers.modal.title")} primaryAction={modalPrimary} secondaryActions={[{ content: t("action.cancel"), onAction: closeAdd }]}>
        <Modal.Section>
          <FormLayout>
            {errorText && modalIntent && (
              <Banner tone="critical">
                <p>{errorText}</p>
              </Banner>
            )}
            <Select label={t("suppliers.modal.platform")} options={data.platforms.map((p) => ({ label: p.displayName, value: p.platform }))} value={selected?.platform ?? ""} onChange={setPlatform} helpText={t("suppliers.modal.platformHelp")} />
            {selected && (
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone={selected.configured ? "success" : "attention"}>{selected.configured ? t("suppliers.ready") : t("suppliers.needsApiKeys")}</Badge>
                  <Text as="span" tone="subdued">
                    {selected.description}
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" fontWeight="semibold">
                  {t("suppliers.modal.capabilities")}
                </Text>
                <InlineStack gap="100" wrap>
                  {selected.capabilities.search && <Badge>{t("action.search")}</Badge>}
                  {selected.capabilities.imageSearch && <Badge>{t("suppliers.capability.imageSearch")}</Badge>}
                  {selected.capabilities.placeOrder && <Badge>{t("suppliers.capability.placeOrder")}</Badge>}
                  {selected.capabilities.tracking && <Badge>{t("suppliers.capability.tracking")}</Badge>}
                  {selected.capabilities.shippingQuotes && <Badge>{t("suppliers.capability.shippingQuotes")}</Badge>}
                </InlineStack>
              </BlockStack>
            )}
            {selected && !selected.configured && (
              <Banner tone="warning">
                <p>{t("suppliers.modal.needsApiKeys")}</p>
              </Banner>
            )}
            {selected?.authMode === "oauth" && (
              <Text as="p" tone="subdued">
                {t("suppliers.modal.oauthHelp")}
              </Text>
            )}
            {selected?.authMode === "apikey" && (
              <>
                <TextField label={t("suppliers.accountEmail")} value={cj.email} onChange={(v) => setCj({ ...cj, email: v })} autoComplete="off" />
                <TextField label={t("suppliers.apiKey")} type="password" value={cj.apiKey} onChange={(v) => setCj({ ...cj, apiKey: v })} autoComplete="off" />
                <TextField label={t("suppliers.label")} value={cj.label} onChange={(v) => setCj({ ...cj, label: v })} autoComplete="off" placeholder={t("suppliers.labelPlaceholder")} />
                <Checkbox label={t("suppliers.shareAcrossStores")} checked={cj.share} onChange={(v) => setCj({ ...cj, share: v })} />
              </>
            )}
            {selected?.authMode === "none" && <TextField label={t("suppliers.label")} value={mockLabel} onChange={setMockLabel} autoComplete="off" />}
          </FormLayout>
        </Modal.Section>
      </Modal>

      <Modal
        open={Boolean(disconnecting)}
        onClose={() => setDisconnecting(null)}
        title={t("suppliers.disconnect.title", { label: disconnecting?.label ?? "" })}
        primaryAction={{
          content: t("suppliers.disconnect"),
          destructive: true,
          loading: pending("disconnect"),
          onAction: () => {
            if (!disconnecting) return;
            fetcher.submit({ intent: "disconnect", id: disconnecting.id }, { method: "post" });
            setDisconnecting(null);
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setDisconnecting(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t("suppliers.disconnect.body")}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

/** One label/value line on an account card. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <InlineStack align="space-between" gap="200" blockAlign="baseline">
      <Text as="span" tone="subdued" variant="bodySm">
        {label}
      </Text>
      <Text as="span" variant="bodySm">
        {value}
      </Text>
    </InlineStack>
  );
}
