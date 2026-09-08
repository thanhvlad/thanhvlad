import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, Card, Checkbox, FormLayout, InlineGrid, InlineStack, Layout, Page, Select, Text, TextField } from "@shopify/polaris";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
import { mergeShopSettings } from "~/domain/settings/shop-settings";
import { KNOWN_CARRIERS, deleteShippingPreference, listShippingPreferences, setShippingPreferenceEnabled, upsertShippingPreference } from "~/services/shipping.server";
import { updateShopSettings } from "~/services/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const prefs = await listShippingPreferences(shop.id);
  return {
    currency: shop.currency,
    settings: shop.parsedSettings.shipping,
    carriers: KNOWN_CARRIERS,
    preferences: prefs.map((p) => ({ id: p.id, countryCode: p.countryCode, carrierCode: p.carrierCode, carrierName: p.carrierName, priority: p.priority, maxCost: p.maxCost?.toString() ?? "", maxDeliveryDays: p.maxDeliveryDays, requireTracking: p.requireTracking, isEnabled: p.isEnabled })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { intent, get } = await readForm(request);
  try {
    switch (intent) {
      case "add":
        await upsertShippingPreference(shop.id, {
          countryCode: get("countryCode") || "*",
          carrierCode: get("carrierCode"),
          carrierName: KNOWN_CARRIERS.find((c) => c.code === get("carrierCode"))?.name ?? get("carrierCode"),
          priority: Number(get("priority") || 0),
          maxCost: get("maxCost") || null,
          maxDeliveryDays: get("maxDeliveryDays") ? Number(get("maxDeliveryDays")) : null,
          requireTracking: get("requireTracking") === "true",
        });
        return { ok: true, messageKey: "msg.preferenceSaved" };
      case "toggle":
        await setShippingPreferenceEnabled(shop.id, get("id"), get("enabled") === "true");
        return { ok: true, messageKey: "msg.preferenceUpdated" };
      case "delete":
        await deleteShippingPreference(shop.id, get("id"));
        return { ok: true, messageKey: "msg.preferenceRemoved" };
      case "settings": {
        const next = mergeShopSettings(shop.settings, {
          shipping: { fallback: get("fallback") as "CHEAPEST" | "FASTEST" | "NONE", requireTracking: get("requireTracking") === "true", maxShippingCost: Number(get("maxShippingCost") || 0) },
        });
        await updateShopSettings(shop.id, next);
        return { ok: true, messageKey: "msg.shippingSettingsSaved" };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function ShippingPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const [form, setForm] = useState({ countryCode: "*", carrierCode: data.carriers[0]?.code ?? "", priority: "0", maxCost: "", maxDeliveryDays: "", requireTracking: true });
  const [settings, setSettings] = useState({ fallback: data.settings.fallback, requireTracking: data.settings.requireTracking, maxShippingCost: String(data.settings.maxShippingCost || "") });

  const byCountry = new Map<string, typeof data.preferences>();
  for (const p of data.preferences) byCountry.set(p.countryCode, [...(byCountry.get(p.countryCode) ?? []), p]);

  return (
    <Page title={t("page.shipping.title")} subtitle={t("page.shipping.subtitle")}>
      <Layout>
        <Layout.Section>
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
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {t("shipping.globalRules")}
                </Text>
                <FormLayout>
                  <Select
                    label={t("shipping.fallback.label")}
                    value={settings.fallback}
                    onChange={(v) => setSettings({ ...settings, fallback: v as typeof settings.fallback })}
                    options={[
                      { label: t("shipping.fallback.cheapest"), value: "CHEAPEST" },
                      { label: t("shipping.fallback.fastest"), value: "FASTEST" },
                      { label: t("shipping.fallback.none"), value: "NONE" },
                    ]}
                  />
                  <Checkbox label={t("shipping.requireTrackingGlobal")} checked={settings.requireTracking} onChange={(v) => setSettings({ ...settings, requireTracking: v })} />
                  <TextField label={t("shipping.maxCostPerOrder")} type="number" value={settings.maxShippingCost} onChange={(v) => setSettings({ ...settings, maxShippingCost: v })} autoComplete="off" prefix={data.currency} helpText={t("shipping.maxCostHelp")} />
                  <Button variant="primary" onClick={() => fetcher.submit({ intent: "settings", ...settings, requireTracking: String(settings.requireTracking) }, { method: "post" })}>
                    {t("action.save")}
                  </Button>
                </FormLayout>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {t("shipping.addCarrier.title")}
                </Text>
                <FormLayout>
                  <TextField label={t("shipping.addCarrier.country")} value={form.countryCode} onChange={(v) => setForm({ ...form, countryCode: v.toUpperCase() })} autoComplete="off" />
                  <Select label={t("shipping.addCarrier.carrier")} options={data.carriers.map((c) => ({ label: `${c.name} (${c.code})`, value: c.code }))} value={form.carrierCode} onChange={(v) => setForm({ ...form, carrierCode: v })} />
                  <FormLayout.Group>
                    <TextField label={t("shipping.addCarrier.priority")} type="number" value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} autoComplete="off" />
                    <TextField label={t("shipping.addCarrier.maxCost")} type="number" value={form.maxCost} onChange={(v) => setForm({ ...form, maxCost: v })} autoComplete="off" prefix={data.currency} />
                    <TextField label={t("shipping.addCarrier.maxDays")} type="number" value={form.maxDeliveryDays} onChange={(v) => setForm({ ...form, maxDeliveryDays: v })} autoComplete="off" />
                  </FormLayout.Group>
                  <Checkbox label={t("shipping.addCarrier.requireTracking")} checked={form.requireTracking} onChange={(v) => setForm({ ...form, requireTracking: v })} />
                  <Button onClick={() => fetcher.submit({ intent: "add", ...form, requireTracking: String(form.requireTracking) }, { method: "post" })} loading={fetcher.state !== "idle"}>
                    {t("action.add")}
                  </Button>
                </FormLayout>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("shipping.byDestination")}
              </Text>
              {data.preferences.length === 0 && (
                <Text as="p" tone="subdued">
                  {t("shipping.empty")}
                </Text>
              )}
              {[...byCountry.entries()].map(([country, prefs]) => (
                <Box key={country} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      {country === "*" ? t("shipping.allOtherCountries") : country}
                    </Text>
                    {prefs
                      .sort((a, b) => a.priority - b.priority)
                      .map((p) => (
                        <InlineGrid key={p.id} columns={{ xs: 1, md: ["twoThirds", "oneThird"] }} gap="200">
                          <InlineStack gap="200" blockAlign="center" wrap>
                            <Badge>{`#${p.priority + 1}`}</Badge>
                            <Text as="span" fontWeight="semibold">
                              {p.carrierName ?? p.carrierCode}
                            </Text>
                            <Text as="span" tone="subdued" variant="bodySm">
                              {p.maxCost ? `≤ ${formatMoney(p.maxCost, data.currency)} · ` : ""}
                              {p.maxDeliveryDays ? `≤ ${p.maxDeliveryDays} ${t("common.days")} · ` : ""}
                              {p.requireTracking ? t("shipping.trackingRequired") : t("shipping.trackingOptional")}
                            </Text>
                            {!p.isEnabled && <Badge>{t("common.disabled")}</Badge>}
                          </InlineStack>
                          <InlineStack gap="100" align="end">
                            <Button size="slim" onClick={() => fetcher.submit({ intent: "toggle", id: p.id, countryCode: p.countryCode, carrierCode: p.carrierCode, priority: String(p.priority), requireTracking: String(p.requireTracking), enabled: String(!p.isEnabled) }, { method: "post" })}>
                              {p.isEnabled ? t("action.disable") : t("action.enable")}
                            </Button>
                            <Button size="slim" tone="critical" onClick={() => fetcher.submit({ intent: "delete", id: p.id }, { method: "post" })}>
                              {t("action.remove")}
                            </Button>
                          </InlineStack>
                        </InlineGrid>
                      ))}
                  </BlockStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
