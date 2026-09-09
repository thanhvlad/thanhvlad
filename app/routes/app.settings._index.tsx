import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Banner, BlockStack, Button, Card, Checkbox, FormLayout, InlineGrid, Layout, Select, Text, TextField } from "@shopify/polaris";
import { mergeShopSettings, type ShopSettings } from "~/domain/settings/shop-settings";
import { readForm, requireShop } from "~/lib/auth.server";
import { actionFailure } from "~/lib/errors";
import { SUPPORTED_LOCALES, localeCoverage } from "~/lib/i18n";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
import { requireFeature } from "~/services/billing.server";
import { updateShopSettings } from "~/services/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  return { settings: shop.parsedSettings, currency: shop.currency, country: shop.country };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { json } = await readForm(request);
  try {
    const patch = json<Partial<ShopSettings>>("settings", {});
    if (patch.ui?.locale && patch.ui.locale !== shop.parsedSettings.ui.locale) {
      patch.ui = { ...patch.ui, localeChosen: true };
    }
    if (patch.orders?.autoPlaceOrders && !shop.parsedSettings.orders.autoPlaceOrders) {
      await requireFeature(shop, "autoPlaceOrders");
    }
    await updateShopSettings(shop.id, mergeShopSettings(shop.settings, patch));
    return { ok: true, messageKey: "msg.settingsSaved" };
  } catch (e) {
    return actionFailure(e);
  }
};

export default function GeneralSettings() {
  const { settings, currency } = useLoaderData<typeof loader>();
  const t = useT();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(result as Parameters<typeof useErrorMessage>[0]);
  const [s, setS] = useState<ShopSettings>(settings);
  const save = () => fetcher.submit({ settings: JSON.stringify(s) }, { method: "post" });
  const set = <K extends keyof ShopSettings>(section: K, patch: Partial<ShopSettings[K]>) => setS({ ...s, [section]: { ...s[section], ...patch } });

  return (
    <Layout>
      <Layout.Section>
        {actionMessage && (
          <Banner tone="success">
            <p>{actionMessage}</p>
          </Banner>
        )}
        {failureMessage && (
          <Banner tone="critical">
            <p>{failureMessage}</p>
          </Banner>
        )}
      </Layout.Section>

      <Layout.AnnotatedSection title={t("settings.orders.title")} description={t("settings.orders.description")}>
        <Card>
          <FormLayout>
            <Checkbox label={t("settings.orders.requirePaid.label")} checked={s.orders.requirePaidOrder} onChange={(v) => set("orders", { requirePaidOrder: v })} />
            <Checkbox label={t("settings.orders.blockHighRisk.label")} checked={s.orders.blockHighRisk} onChange={(v) => set("orders", { blockHighRisk: v })} />
            <Checkbox label={t("settings.orders.blockPartiallyPaid.label")} checked={s.orders.blockPartiallyPaid} onChange={(v) => set("orders", { blockPartiallyPaid: v })} />
            <Checkbox label={t("settings.orders.autoPlace.label")} checked={s.orders.autoPlaceOrders} onChange={(v) => set("orders", { autoPlaceOrders: v })} helpText={t("settings.orders.autoPlace.help")} />
            <Checkbox label={t("settings.orders.requireApproval.label")} checked={s.orders.requireApprovalOnFulfillmentRequest} onChange={(v) => set("orders", { requireApprovalOnFulfillmentRequest: v })} helpText={t("settings.orders.requireApproval.help")} />
            <TextField label={t("settings.orders.autoPlaceDelay.label")} type="number" value={String(s.orders.autoPlaceDelayMinutes)} onChange={(v) => set("orders", { autoPlaceDelayMinutes: Number(v) })} autoComplete="off" disabled={!s.orders.autoPlaceOrders} />
            <TextField label={t("settings.orders.supplierNote.label")} value={s.orders.supplierNote} onChange={(v) => set("orders", { supplierNote: v })} autoComplete="off" multiline={2} maxLength={500} showCharacterCount />
            <InlineGrid columns={2} gap="200">
              <TextField label={t("settings.orders.tagOnPlaced.label")} value={s.orders.tagOnPlaced} onChange={(v) => set("orders", { tagOnPlaced: v })} autoComplete="off" />
              <TextField label={t("settings.orders.tagOnShipped.label")} value={s.orders.tagOnShipped} onChange={(v) => set("orders", { tagOnShipped: v })} autoComplete="off" />
            </InlineGrid>
            <TextField label={t("settings.orders.phoneFallback.label")} value={s.orders.phoneFallback} onChange={(v) => set("orders", { phoneFallback: v })} autoComplete="off" helpText={t("settings.orders.phoneFallback.help")} />
            <Checkbox label={t("settings.orders.overridePhone.label")} checked={s.orders.overridePhone} onChange={(v) => set("orders", { overridePhone: v })} />
            <Checkbox label={t("settings.orders.autoFixAddress.label")} checked={s.orders.autoFixAddress} onChange={(v) => set("orders", { autoFixAddress: v })} />
            <Checkbox label={t("settings.orders.cancelSupplierOnCancel.label")} checked={s.orders.cancelSupplierOnCancel} onChange={(v) => set("orders", { cancelSupplierOnCancel: v })} />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.fulfillment.title")} description={t("settings.fulfillment.description")}>
        <Card>
          <FormLayout>
            <Checkbox label={t("settings.fulfillment.autoFulfill.label")} checked={s.fulfillment.autoFulfill} onChange={(v) => set("fulfillment", { autoFulfill: v })} />
            <Checkbox label={t("settings.fulfillment.notifyCustomer.label")} checked={s.fulfillment.notifyCustomer} onChange={(v) => set("fulfillment", { notifyCustomer: v })} />
            <Checkbox label={t("settings.fulfillment.trackDelivery.label")} checked={s.fulfillment.trackDelivery} onChange={(v) => set("fulfillment", { trackDelivery: v })} />
            <TextField label={t("settings.fulfillment.carrierNameOverride.label")} value={s.fulfillment.carrierNameOverride} onChange={(v) => set("fulfillment", { carrierNameOverride: v })} autoComplete="off" placeholder={t("settings.fulfillment.carrierNameOverride.placeholder")} />
            <TextField label={t("settings.fulfillment.trackingUrlTemplate.label")} value={s.fulfillment.trackingUrlTemplate} onChange={(v) => set("fulfillment", { trackingUrlTemplate: v })} autoComplete="off" placeholder="https://mystore.com/track?number={tracking}" helpText={t("settings.fulfillment.trackingUrlTemplate.help")} />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.products.title")} description={t("settings.products.description")}>
        <Card>
          <FormLayout>
            <InlineGrid columns={2} gap="200">
              <Select
                label={t("settings.products.defaultStatus.label")}
                value={s.products.defaultStatus}
                onChange={(v) => set("products", { defaultStatus: v as "ACTIVE" | "DRAFT" })}
                options={[
                  { label: t("settings.products.defaultStatus.active"), value: "ACTIVE" },
                  { label: t("settings.products.defaultStatus.draft"), value: "DRAFT" },
                ]}
              />
              <Select
                label={t("settings.products.weightUnit.label")}
                value={s.products.weightUnit}
                onChange={(v) => set("products", { weightUnit: v as ShopSettings["products"]["weightUnit"] })}
                options={[
                  { label: t("settings.products.weightUnit.grams"), value: "GRAMS" },
                  { label: t("settings.products.weightUnit.kilograms"), value: "KILOGRAMS" },
                  { label: t("settings.products.weightUnit.ounces"), value: "OUNCES" },
                  { label: t("settings.products.weightUnit.pounds"), value: "POUNDS" },
                ]}
              />
            </InlineGrid>
            <Checkbox label={t("settings.products.publishOnPush.label")} checked={s.products.publishOnPush} onChange={(v) => set("products", { publishOnPush: v })} />
            <Checkbox label={t("settings.products.trackInventory.label")} checked={s.products.trackInventory} onChange={(v) => set("products", { trackInventory: v })} />
            <TextField label={t("settings.products.initialInventory.label")} type="number" value={String(s.products.initialInventory)} onChange={(v) => set("products", { initialInventory: Number(v) })} autoComplete="off" />
            <InlineGrid columns={3} gap="200">
              <TextField label={t("settings.products.defaultVendor.label")} value={s.products.defaultVendor} onChange={(v) => set("products", { defaultVendor: v })} autoComplete="off" />
              <TextField label={t("settings.products.defaultProductType.label")} value={s.products.defaultProductType} onChange={(v) => set("products", { defaultProductType: v })} autoComplete="off" />
              <TextField label={t("settings.products.defaultTags.label")} value={s.products.defaultTags} onChange={(v) => set("products", { defaultTags: v })} autoComplete="off" />
            </InlineGrid>
            <Checkbox label={t("settings.products.importDescription.label")} checked={s.products.importDescription} onChange={(v) => set("products", { importDescription: v })} />
            <Checkbox label={t("settings.products.cleanDescription.label")} checked={s.products.cleanDescription} onChange={(v) => set("products", { cleanDescription: v })} />
            <TextField label={t("settings.products.maxImages.label")} type="number" value={String(s.products.maxImages)} onChange={(v) => set("products", { maxImages: Number(v) })} autoComplete="off" />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.currency.title")} description={`${t("settings.currency.descriptionBefore")} ${currency} ${t("settings.currency.descriptionAfter")}`}>
        <Card>
          <FormLayout>
            <TextField label={t("settings.currency.supplierCurrency.label")} value={s.currency.supplierCurrency} onChange={(v) => set("currency", { supplierCurrency: v.toUpperCase() })} autoComplete="off" />
            <TextField label={t("settings.currency.manualRate.label")} type="number" value={String(s.currency.manualRate)} onChange={(v) => set("currency", { manualRate: Number(v) })} autoComplete="off" />
            <TextField label={t("settings.currency.bufferPercent.label")} type="number" value={String(s.currency.bufferPercent)} onChange={(v) => set("currency", { bufferPercent: Number(v) })} autoComplete="off" helpText={t("settings.currency.bufferPercent.help")} />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.notifications.title")} description={t("settings.notifications.description")}>
        <Card>
          <FormLayout>
            <TextField label={t("settings.notifications.email.label")} type="email" value={s.notifications.email} onChange={(v) => set("notifications", { email: v })} autoComplete="off" helpText={t("settings.notifications.email.help")} />
            <Checkbox label={t("settings.notifications.onOrderFailed.label")} checked={s.notifications.onOrderFailed} onChange={(v) => set("notifications", { onOrderFailed: v })} />
            <Checkbox label={t("settings.notifications.onPriceChange.label")} checked={s.notifications.onPriceChange} onChange={(v) => set("notifications", { onPriceChange: v })} />
            <Checkbox label={t("settings.notifications.onOutOfStock.label")} checked={s.notifications.onOutOfStock} onChange={(v) => set("notifications", { onOutOfStock: v })} />
            <Checkbox label={t("settings.notifications.onProductRemoved.label")} checked={s.notifications.onProductRemoved} onChange={(v) => set("notifications", { onProductRemoved: v })} />
            <Checkbox label={t("settings.notifications.onTrackingSynced.label")} checked={s.notifications.onTrackingSynced} onChange={(v) => set("notifications", { onTrackingSynced: v })} />
            <Checkbox label={t("settings.notifications.digest.label")} checked={s.notifications.digest} onChange={(v) => set("notifications", { digest: v })} />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.ui.title")} description={t("settings.ui.description")}>
        <Card>
          <FormLayout>
            <Select
              label={t("settings.ui.language.label")}
              value={s.ui.locale}
              onChange={(v) => set("ui", { locale: v as "en" | "vi" })}
              options={SUPPORTED_LOCALES}
              helpText={
                s.ui.locale === "en"
                  ? t("settings.ui.language.sourceLanguage")
                  : `${localeCoverage(s.ui.locale).percent}% ${t("settings.ui.language.coverage")}`
              }
            />
            <TextField label={t("settings.ui.ordersPageSize.label")} type="number" value={String(s.ui.ordersPageSize)} onChange={(v) => set("ui", { ordersPageSize: Number(v) })} autoComplete="off" />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.Section>
        <BlockStack inlineAlign="end">
          <Button variant="primary" onClick={save} loading={fetcher.state !== "idle"}>
            {t("settings.actions.save")}
          </Button>
        </BlockStack>
        <Text as="p" tone="subdued" variant="bodySm">
          &nbsp;
        </Text>
      </Layout.Section>
    </Layout>
  );
}
