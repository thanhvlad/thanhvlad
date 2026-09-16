import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Badge, Banner, BlockStack, Button, Card, Checkbox, FormLayout, IndexTable, InlineGrid, Layout, Modal, Page, Select, Text, TextField, useIndexResourceState } from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { SectionHeader } from "~/components/SectionHeader";
import { Stat } from "~/components/Stat";
import { StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney } from "~/lib/format";
import { useErrorMessage, useLocale, useMessage, useT } from "~/lib/use-t";
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

type Preference = SerializeFrom<typeof loader>["preferences"][number];
type PrefForm = { editing: boolean; countryCode: string; carrierCode: string; priority: string; maxCost: string; maxDeliveryDays: string; requireTracking: boolean };

export default function ShippingPage() {
  const t = useT();
  const locale = useLocale();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const errorText = useErrorMessage(result);
  const busy = fetcher.state !== "idle";
  const pending = (intent: string, id?: string) => busy && fetcher.formData?.get("intent") === intent && (id === undefined || fetcher.formData?.get("id") === id);

  const [settings, setSettings] = useState({ fallback: data.settings.fallback, requireTracking: data.settings.requireTracking, maxShippingCost: String(data.settings.maxShippingCost || "") });

  // Add/edit modal. "Edit" reuses the add intent: the service upserts on
  // destination + carrier, so those two fields are locked while editing and the
  // submit lands on the same row.
  const [form, setForm] = useState<PrefForm | null>(null);
  const [removing, setRemoving] = useState<Preference | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // A modal stays open while its submit is in flight, so its button can show
  // progress and a failure lands inside the modal rather than behind it.
  // `wasBusy` makes the effect wait for the fetcher to have actually started:
  // the state update and the submit do not always land in the same render.
  const [submitting, setSubmitting] = useState<"add" | "delete" | null>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current || !submitting) return;
    wasBusy.current = false;
    const intent = submitting;
    setSubmitting(null);
    if (intent === "add") {
      if (result?.error) setFormError(result.error);
      else setForm(null);
    } else {
      setRemoving(null);
    }
  }, [busy, submitting, result?.error]);

  const openAdd = () => {
    setFormError(null);
    setForm({ editing: false, countryCode: "*", carrierCode: data.carriers[0]?.code ?? "", priority: "0", maxCost: "", maxDeliveryDays: "", requireTracking: true });
  };
  const openEdit = (p: Preference) => {
    setFormError(null);
    setForm({ editing: true, countryCode: p.countryCode, carrierCode: p.carrierCode, priority: String(p.priority), maxCost: p.maxCost, maxDeliveryDays: p.maxDeliveryDays === null ? "" : String(p.maxDeliveryDays), requireTracking: p.requireTracking });
  };
  const closeForm = () => {
    setForm(null);
    setFormError(null);
  };
  const saveForm = () => {
    if (!form) return;
    setFormError(null);
    setSubmitting("add");
    fetcher.submit({ intent: "add", countryCode: form.countryCode, carrierCode: form.carrierCode, priority: form.priority, maxCost: form.maxCost, maxDeliveryDays: form.maxDeliveryDays, requireTracking: String(form.requireTracking) }, { method: "post" });
  };

  const toggle = (p: Preference) => {
    fetcher.submit({ intent: "toggle", id: p.id, countryCode: p.countryCode, carrierCode: p.carrierCode, priority: String(p.priority), requireTracking: String(p.requireTracking), enabled: String(!p.isEnabled) }, { method: "post" });
    clearSelection();
  };
  const confirmRemove = () => {
    if (!removing) return;
    setSubmitting("delete");
    fetcher.submit({ intent: "delete", id: removing.id }, { method: "post" });
    clearSelection();
  };

  // Rows grouped by destination, most-preferred first; "everywhere else" last.
  const rows = [...data.preferences]
    .sort((a, b) => (a.countryCode === "*" ? 1 : b.countryCode === "*" ? -1 : a.countryCode.localeCompare(b.countryCode)) || a.priority - b.priority)
    .map((p, i, all) => ({ ...p, rank: all.slice(0, i).filter((q) => q.countryCode === p.countryCode).length }));
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(rows);
  const selectedPref = selectedResources.length === 1 ? rows.find((r) => r.id === selectedResources[0]) : undefined;

  const countryName = (code: string) => {
    if (code === "*") return t("shipping.allOtherCountries");
    try {
      return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const fallbackLabel = { CHEAPEST: t("shipping.stat.fallback.CHEAPEST"), FASTEST: t("shipping.stat.fallback.FASTEST"), NONE: t("shipping.stat.fallback.NONE") }[data.settings.fallback] ?? data.settings.fallback;
  const destinations = new Set(data.preferences.map((p) => p.countryCode)).size;
  const enabledCount = data.preferences.filter((p) => p.isEnabled).length;

  return (
    <Page fullWidth title={t("page.shipping.title")} subtitle={t("page.shipping.subtitle")} primaryAction={{ content: t("shipping.addPreference"), onAction: openAdd }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
            {actionMessage && (
              <Banner tone="success">
                <p>{actionMessage}</p>
              </Banner>
            )}
            {errorText && !form && (
              <Banner tone="critical">
                <p>{errorText}</p>
              </Banner>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            <Stat label={t("shipping.stat.destinations")} value={String(destinations)} hint={data.preferences.some((p) => p.countryCode === "*") ? t("shipping.stat.destinationsHint") : undefined} />
            <Stat label={t("shipping.stat.carriers")} value={String(data.preferences.length)} hint={t("shipping.stat.carriersHint", { enabled: enabledCount })} />
            <Stat label={t("shipping.stat.fallback")} value={fallbackLabel} tone={data.settings.fallback === "NONE" ? "warning" : "default"} />
            <Stat label={t("shipping.stat.maxCost")} value={data.settings.maxShippingCost ? formatMoney(data.settings.maxShippingCost, data.currency) : t("shipping.stat.noLimit")} />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          {data.preferences.length === 0 ? (
            <EmptyScreen heading={t("shipping.emptyState.heading")} body={t("shipping.empty")} action={{ content: t("shipping.addPreference"), onAction: openAdd }} />
          ) : (
            <Card padding="0">
              <IndexTable
                resourceName={{ singular: t("shipping.resource.singular"), plural: t("shipping.resource.plural") }}
                itemCount={rows.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                promotedBulkActions={[
                  { content: t("action.edit"), disabled: !selectedPref, onAction: () => selectedPref && openEdit(selectedPref) },
                  { content: selectedPref && !selectedPref.isEnabled ? t("action.enable") : t("action.disable"), disabled: !selectedPref || busy, onAction: () => selectedPref && toggle(selectedPref) },
                  { content: t("action.remove"), disabled: !selectedPref || busy, onAction: () => selectedPref && setRemoving(selectedPref) },
                ]}
                headings={[
                  { title: t("shipping.table.destination") },
                  { title: t("shipping.table.carrier") },
                  { title: t("shipping.table.order") },
                  { title: t("shipping.table.maxCost"), alignment: "end" },
                  { title: t("shipping.table.maxDays"), alignment: "end" },
                  { title: t("shipping.table.tracking") },
                  { title: t("common.status") },
                ]}
              >
                {/* The row itself opens the preference, the way a row opens an
                    order in the Shopify admin. Buttons inside a row would also
                    toggle its checkbox — Polaris puts the click handler on the
                    <tr> — so the row's actions live in the bulk action bar. */}
                {rows.map((p, index) => (
                  <IndexTable.Row id={p.id} key={p.id} position={index} selected={selectedResources.includes(p.id)} onClick={() => openEdit(p)}>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">
                          {countryName(p.countryCode)}
                        </Text>
                        {p.countryCode !== "*" && (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {p.countryCode}
                          </Text>
                        )}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span">{p.carrierName ?? p.carrierCode}</Text>
                        {p.carrierName && (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {p.carrierCode}
                          </Text>
                        )}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={p.rank === 0 ? "info" : undefined}>{p.rank === 0 ? t("shipping.table.preferred") : t("shipping.table.fallback", { n: p.rank })}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" alignment="end" numeric>
                        {p.maxCost ? formatMoney(p.maxCost, data.currency) : "—"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" alignment="end" numeric>
                        {p.maxDeliveryDays ? `${p.maxDeliveryDays} ${t("common.days")}` : "—"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={p.requireTracking ? "success" : undefined}>{p.requireTracking ? t("shipping.table.trackingRequired") : t("shipping.table.trackingOptional")}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <StatusBadge status={p.isEnabled ? "ENABLED" : "DISABLED"} />
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          )}
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <SectionHeader title={t("shipping.globalRules")} />
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
                <Button variant="primary" loading={pending("settings")} onClick={() => fetcher.submit({ intent: "settings", ...settings, requireTracking: String(settings.requireTracking) }, { method: "post" })}>
                  {t("action.save")}
                </Button>
              </FormLayout>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={form !== null}
        onClose={closeForm}
        title={form?.editing ? t("shipping.editPreference") : t("shipping.addCarrier.title")}
        primaryAction={{ content: form?.editing ? t("action.save") : t("action.add"), onAction: saveForm, disabled: !form?.carrierCode, loading: pending("add") }}
        secondaryActions={[{ content: t("action.cancel"), onAction: closeForm }]}
      >
        {form && (
          <Modal.Section>
            <FormLayout>
              {formError && (
                <Banner tone="critical">
                  <p>{formError}</p>
                </Banner>
              )}
              <TextField label={t("shipping.addCarrier.country")} value={form.countryCode} onChange={(v) => setForm({ ...form, countryCode: v.toUpperCase() })} autoComplete="off" disabled={form.editing} helpText={t("shipping.form.countryHelp")} />
              <Select label={t("shipping.addCarrier.carrier")} options={data.carriers.map((c) => ({ label: `${c.name} (${c.code})`, value: c.code }))} value={form.carrierCode} onChange={(v) => setForm({ ...form, carrierCode: v })} disabled={form.editing} />
              <TextField label={t("shipping.addCarrier.priority")} type="number" value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} autoComplete="off" helpText={t("shipping.form.priorityHelp")} />
              <FormLayout.Group>
                <TextField label={t("shipping.addCarrier.maxCost")} type="number" value={form.maxCost} onChange={(v) => setForm({ ...form, maxCost: v })} autoComplete="off" prefix={data.currency} helpText={t("shipping.form.maxCostHelp")} />
                <TextField label={t("shipping.addCarrier.maxDays")} type="number" value={form.maxDeliveryDays} onChange={(v) => setForm({ ...form, maxDeliveryDays: v })} autoComplete="off" helpText={t("shipping.form.maxDaysHelp")} />
              </FormLayout.Group>
              <Checkbox label={t("shipping.addCarrier.requireTracking")} checked={form.requireTracking} onChange={(v) => setForm({ ...form, requireTracking: v })} />
            </FormLayout>
          </Modal.Section>
        )}
      </Modal>

      <Modal
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={t("shipping.remove.title", { carrier: removing?.carrierName ?? removing?.carrierCode ?? "", destination: removing ? countryName(removing.countryCode) : "" })}
        primaryAction={{ content: t("action.remove"), destructive: true, loading: pending("delete", removing?.id), onAction: confirmRemove }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setRemoving(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t("shipping.remove.body")}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
