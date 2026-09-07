import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Banner, BlockStack, Button, Card, Checkbox, FormLayout, InlineGrid, Layout, Select, Text, TextField } from "@shopify/polaris";
import { mergeShopSettings, type ShopSettings } from "~/domain/settings/shop-settings";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { SUPPORTED_LOCALES } from "~/lib/i18n";
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
    await updateShopSettings(shop.id, mergeShopSettings(shop.settings, patch));
    return { ok: true, message: "Settings saved." };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function GeneralSettings() {
  const { settings, currency } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const [s, setS] = useState<ShopSettings>(settings);
  const save = () => fetcher.submit({ settings: JSON.stringify(s) }, { method: "post" });
  const set = <K extends keyof ShopSettings>(section: K, patch: Partial<ShopSettings[K]>) => setS({ ...s, [section]: { ...s[section], ...patch } });

  return (
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

      <Layout.AnnotatedSection title="Orders" description="When and how supplier orders are placed.">
        <Card>
          <FormLayout>
            <Checkbox label="Only place supplier orders once the Shopify order is paid" checked={s.orders.requirePaidOrder} onChange={(v) => set("orders", { requirePaidOrder: v })} />
            <Checkbox label="Block orders Shopify flags as high risk" checked={s.orders.blockHighRisk} onChange={(v) => set("orders", { blockHighRisk: v })} />
            <Checkbox label="Block partially paid orders" checked={s.orders.blockPartiallyPaid} onChange={(v) => set("orders", { blockPartiallyPaid: v })} />
            <Checkbox label="Automatically place supplier orders when ready" checked={s.orders.autoPlaceOrders} onChange={(v) => set("orders", { autoPlaceOrders: v })} helpText="Runs every 10 minutes for orders older than the delay below." />
            <TextField label="Auto-place delay (minutes)" type="number" value={String(s.orders.autoPlaceDelayMinutes)} onChange={(v) => set("orders", { autoPlaceDelayMinutes: Number(v) })} autoComplete="off" disabled={!s.orders.autoPlaceOrders} />
            <TextField label="Note sent to suppliers with every order" value={s.orders.supplierNote} onChange={(v) => set("orders", { supplierNote: v })} autoComplete="off" multiline={2} maxLength={500} showCharacterCount />
            <InlineGrid columns={2} gap="200">
              <TextField label="Tag Shopify order when placed" value={s.orders.tagOnPlaced} onChange={(v) => set("orders", { tagOnPlaced: v })} autoComplete="off" />
              <TextField label="Tag Shopify order when shipped" value={s.orders.tagOnShipped} onChange={(v) => set("orders", { tagOnShipped: v })} autoComplete="off" />
            </InlineGrid>
            <TextField label="Fallback phone number" value={s.orders.phoneFallback} onChange={(v) => set("orders", { phoneFallback: v })} autoComplete="off" helpText="Used when the customer left no phone (suppliers require one)." />
            <Checkbox label="Always use the fallback phone instead of the customer's" checked={s.orders.overridePhone} onChange={(v) => set("orders", { overridePhone: v })} />
            <Checkbox label="Automatically split over-long address lines" checked={s.orders.autoFixAddress} onChange={(v) => set("orders", { autoFixAddress: v })} />
            <Checkbox label="Cancel supplier orders when the Shopify order is cancelled" checked={s.orders.cancelSupplierOnCancel} onChange={(v) => set("orders", { cancelSupplierOnCancel: v })} />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="Fulfilment" description="How tracking numbers are pushed to Shopify.">
        <Card>
          <FormLayout>
            <Checkbox label="Create Shopify fulfilments automatically when tracking arrives" checked={s.fulfillment.autoFulfill} onChange={(v) => set("fulfillment", { autoFulfill: v })} />
            <Checkbox label="Email the customer their tracking number" checked={s.fulfillment.notifyCustomer} onChange={(v) => set("fulfillment", { notifyCustomer: v })} />
            <Checkbox label="Keep polling carriers until delivered" checked={s.fulfillment.trackDelivery} onChange={(v) => set("fulfillment", { trackDelivery: v })} />
            <TextField label="Show this carrier name instead of the supplier's" value={s.fulfillment.carrierNameOverride} onChange={(v) => set("fulfillment", { carrierNameOverride: v })} autoComplete="off" placeholder="e.g. Standard Shipping" />
            <TextField label="Custom tracking URL template" value={s.fulfillment.trackingUrlTemplate} onChange={(v) => set("fulfillment", { trackingUrlTemplate: v })} autoComplete="off" placeholder="https://mystore.com/track?number={tracking}" helpText="{tracking} is replaced with the number." />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="Products" description="Defaults for products pushed from the import list.">
        <Card>
          <FormLayout>
            <InlineGrid columns={2} gap="200">
              <Select label="Status on push" value={s.products.defaultStatus} onChange={(v) => set("products", { defaultStatus: v as "ACTIVE" | "DRAFT" })} options={[{ label: "Active", value: "ACTIVE" }, { label: "Draft", value: "DRAFT" }]} />
              <Select label="Weight unit" value={s.products.weightUnit} onChange={(v) => set("products", { weightUnit: v as ShopSettings["products"]["weightUnit"] })} options={["GRAMS", "KILOGRAMS", "OUNCES", "POUNDS"].map((u) => ({ label: u.toLowerCase(), value: u }))} />
            </InlineGrid>
            <Checkbox label="Publish to online store on push" checked={s.products.publishOnPush} onChange={(v) => set("products", { publishOnPush: v })} />
            <Checkbox label="Track inventory in Shopify" checked={s.products.trackInventory} onChange={(v) => set("products", { trackInventory: v })} />
            <TextField label="Initial inventory per variant" type="number" value={String(s.products.initialInventory)} onChange={(v) => set("products", { initialInventory: Number(v) })} autoComplete="off" />
            <InlineGrid columns={3} gap="200">
              <TextField label="Default vendor" value={s.products.defaultVendor} onChange={(v) => set("products", { defaultVendor: v })} autoComplete="off" />
              <TextField label="Default product type" value={s.products.defaultProductType} onChange={(v) => set("products", { defaultProductType: v })} autoComplete="off" />
              <TextField label="Default tags" value={s.products.defaultTags} onChange={(v) => set("products", { defaultTags: v })} autoComplete="off" />
            </InlineGrid>
            <Checkbox label="Import the supplier description" checked={s.products.importDescription} onChange={(v) => set("products", { importDescription: v })} />
            <Checkbox label="Strip supplier links and store names from descriptions" checked={s.products.cleanDescription} onChange={(v) => set("products", { cleanDescription: v })} />
            <TextField label="Maximum images per product" type="number" value={String(s.products.maxImages)} onChange={(v) => set("products", { maxImages: Number(v) })} autoComplete="off" />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="Currency" description={`Supplier prices are converted to ${currency} before the pricing rule runs.`}>
        <Card>
          <FormLayout>
            <TextField label="Supplier currency" value={s.currency.supplierCurrency} onChange={(v) => set("currency", { supplierCurrency: v.toUpperCase() })} autoComplete="off" />
            <TextField label="Manual exchange rate (0 = live market rate)" type="number" value={String(s.currency.manualRate)} onChange={(v) => set("currency", { manualRate: Number(v) })} autoComplete="off" />
            <TextField label="Safety buffer on the rate (%)" type="number" value={String(s.currency.bufferPercent)} onChange={(v) => set("currency", { bufferPercent: Number(v) })} autoComplete="off" helpText="Protects margins against currency swings." />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="Notifications" description="What shows up in the notifications feed.">
        <Card>
          <FormLayout>
            <TextField label="Notification email" type="email" value={s.notifications.email} onChange={(v) => set("notifications", { email: v })} autoComplete="off" helpText="Used by the daily digest when email delivery is configured." />
            <Checkbox label="Failed supplier orders" checked={s.notifications.onOrderFailed} onChange={(v) => set("notifications", { onOrderFailed: v })} />
            <Checkbox label="Supplier price changes" checked={s.notifications.onPriceChange} onChange={(v) => set("notifications", { onPriceChange: v })} />
            <Checkbox label="Supplier out of stock" checked={s.notifications.onOutOfStock} onChange={(v) => set("notifications", { onOutOfStock: v })} />
            <Checkbox label="Supplier product removed" checked={s.notifications.onProductRemoved} onChange={(v) => set("notifications", { onProductRemoved: v })} />
            <Checkbox label="Tracking synced to Shopify" checked={s.notifications.onTrackingSynced} onChange={(v) => set("notifications", { onTrackingSynced: v })} />
            <Checkbox label="Daily digest instead of instant notifications" checked={s.notifications.digest} onChange={(v) => set("notifications", { digest: v })} />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="Interface" description="Language and list sizes.">
        <Card>
          <FormLayout>
            <Select label="Language" value={s.ui.locale} onChange={(v) => set("ui", { locale: v as "en" | "vi" })} options={SUPPORTED_LOCALES} />
            <TextField label="Orders per page" type="number" value={String(s.ui.ordersPageSize)} onChange={(v) => set("ui", { ordersPageSize: Number(v) })} autoComplete="off" />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.Section>
        <BlockStack inlineAlign="end">
          <Button variant="primary" onClick={save} loading={fetcher.state !== "idle"}>
            Save settings
          </Button>
        </BlockStack>
        <Text as="p" tone="subdued" variant="bodySm">
          &nbsp;
        </Text>
      </Layout.Section>
    </Layout>
  );
}
