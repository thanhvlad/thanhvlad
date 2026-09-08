import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, Card, Checkbox, FormLayout, InlineGrid, InlineStack, Layout, Page, Select, Text, TextField } from "@shopify/polaris";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney } from "~/lib/format";
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
        return { ok: true, message: "Preference saved." };
      case "toggle":
        await setShippingPreferenceEnabled(shop.id, get("id"), get("enabled") === "true");
        return { ok: true, message: "Preference updated." };
      case "delete":
        await deleteShippingPreference(shop.id, get("id"));
        return { ok: true, message: "Preference removed." };
      case "settings": {
        const next = mergeShopSettings(shop.settings, {
          shipping: { fallback: get("fallback") as "CHEAPEST" | "FASTEST" | "NONE", requireTracking: get("requireTracking") === "true", maxShippingCost: Number(get("maxShippingCost") || 0) },
        });
        await updateShopSettings(shop.id, next);
        return { ok: true, message: "Shipping settings saved." };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function ShippingPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const [form, setForm] = useState({ countryCode: "*", carrierCode: data.carriers[0]?.code ?? "", priority: "0", maxCost: "", maxDeliveryDays: "", requireTracking: true });
  const [settings, setSettings] = useState({ fallback: data.settings.fallback, requireTracking: data.settings.requireTracking, maxShippingCost: String(data.settings.maxShippingCost || "") });

  const byCountry = new Map<string, typeof data.preferences>();
  for (const p of data.preferences) byCountry.set(p.countryCode, [...(byCountry.get(p.countryCode) ?? []), p]);

  return (
    <Page title="Shipping" subtitle="Which supplier shipping method to pick for each destination.">
      <Layout>
        <Layout.Section>
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
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Global rules
                </Text>
                <FormLayout>
                  <Select
                    label="When no preferred carrier is available"
                    value={settings.fallback}
                    onChange={(v) => setSettings({ ...settings, fallback: v as typeof settings.fallback })}
                    options={[
                      { label: "Use the cheapest method", value: "CHEAPEST" },
                      { label: "Use the fastest method", value: "FASTEST" },
                      { label: "Do not place the order", value: "NONE" },
                    ]}
                  />
                  <Checkbox label="Only use methods with tracking" checked={settings.requireTracking} onChange={(v) => setSettings({ ...settings, requireTracking: v })} />
                  <TextField label="Maximum shipping cost per order" type="number" value={settings.maxShippingCost} onChange={(v) => setSettings({ ...settings, maxShippingCost: v })} autoComplete="off" prefix={data.currency} helpText="Blank or 0 = no limit" />
                  <Button variant="primary" onClick={() => fetcher.submit({ intent: "settings", ...settings, requireTracking: String(settings.requireTracking) }, { method: "post" })}>
                    Save
                  </Button>
                </FormLayout>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Add preferred carrier
                </Text>
                <FormLayout>
                  <TextField label="Destination country (ISO code, * = everywhere)" value={form.countryCode} onChange={(v) => setForm({ ...form, countryCode: v.toUpperCase() })} autoComplete="off" />
                  <Select label="Carrier" options={data.carriers.map((c) => ({ label: `${c.name} (${c.code})`, value: c.code }))} value={form.carrierCode} onChange={(v) => setForm({ ...form, carrierCode: v })} />
                  <FormLayout.Group>
                    <TextField label="Priority (0 = first)" type="number" value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} autoComplete="off" />
                    <TextField label="Max cost" type="number" value={form.maxCost} onChange={(v) => setForm({ ...form, maxCost: v })} autoComplete="off" prefix={data.currency} />
                    <TextField label="Max days" type="number" value={form.maxDeliveryDays} onChange={(v) => setForm({ ...form, maxDeliveryDays: v })} autoComplete="off" />
                  </FormLayout.Group>
                  <Checkbox label="Require tracking" checked={form.requireTracking} onChange={(v) => setForm({ ...form, requireTracking: v })} />
                  <Button onClick={() => fetcher.submit({ intent: "add", ...form, requireTracking: String(form.requireTracking) }, { method: "post" })} loading={fetcher.state !== "idle"}>
                    Add
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
                Preferences by destination
              </Text>
              {data.preferences.length === 0 && (
                <Text as="p" tone="subdued">
                  No preferences yet. Orders will use the {data.settings.fallback.toLowerCase()} method the supplier offers.
                </Text>
              )}
              {[...byCountry.entries()].map(([country, prefs]) => (
                <Box key={country} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      {country === "*" ? "All other countries" : country}
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
                              {p.maxDeliveryDays ? `≤ ${p.maxDeliveryDays} days · ` : ""}
                              {p.requireTracking ? "tracking required" : "tracking optional"}
                            </Text>
                            {!p.isEnabled && <Badge>Disabled</Badge>}
                          </InlineStack>
                          <InlineStack gap="100" align="end">
                            <Button size="slim" onClick={() => fetcher.submit({ intent: "toggle", id: p.id, countryCode: p.countryCode, carrierCode: p.carrierCode, priority: String(p.priority), requireTracking: String(p.requireTracking), enabled: String(!p.isEnabled) }, { method: "post" })}>
                              {p.isEnabled ? "Disable" : "Enable"}
                            </Button>
                            <Button size="slim" tone="critical" onClick={() => fetcher.submit({ intent: "delete", id: p.id }, { method: "post" })}>
                              Remove
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
