import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  Divider,
  FormLayout,
  InlineGrid,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { ChevronLeftIcon, ChevronRightIcon, DeleteIcon } from "@shopify/polaris-icons";
import { EmptyScreen } from "~/components/EmptyScreen";
import { MarginText, marginTone } from "~/components/import-margin";
import { SectionHeader } from "~/components/SectionHeader";
import { Stat } from "~/components/Stat";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney, formatPercent } from "~/lib/format";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
import {
  applyPricingRuleToImport,
  getImportedProduct,
  pushImportedProduct,
  removeFromImportList,
  splitImportedProduct,
  updateImportedProduct,
  updateImportedVariants,
} from "~/services/import.server";
import { listPricingRules } from "~/services/pricing.server";
import { listCollections } from "~/services/shopify/products.server";
import { getShippingOptions } from "~/services/suppliers/catalog.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop, graphql } = await requireShop(request);
  const product = await getImportedProduct(shop.id, params.id!);
  if (!product) throw new Response("Not found", { status: 404 });
  const [rules, collections] = await Promise.all([
    listPricingRules(shop.id),
    listCollections(graphql).catch(() => [] as Array<{ id: string; title: string; handle: string }>),
  ]);
  let shipping: Awaited<ReturnType<typeof getShippingOptions>> = [];
  if (product.supplierProductId) {
    shipping = await getShippingOptions(shop.id, product.supplierProductId, {
      shipToCountry: shop.country ?? "US",
      externalSkuId: product.variants[0]?.supplierVariant?.externalSkuId ?? null,
      quantity: 1,
    }).catch(() => []);
  }
  return {
    currency: shop.currency,
    country: shop.country ?? "US",
    product: {
      id: product.id,
      title: product.title,
      description: product.description,
      vendor: product.vendor ?? "",
      productType: product.productType ?? "",
      tags: product.tags.join(", "),
      handle: product.handle ?? "",
      collections: product.collections,
      images: product.images,
      options: product.options as unknown as string[],
      excludedValues: (product.excludedValues ?? {}) as Record<string, string[]>,
      status: product.status,
      pushError: product.pushError,
      pushedProductId: product.pushedProductId,
      pricingRuleId: product.pricingRuleId ?? "",
      supplier: product.supplierProduct
        ? { platform: product.supplierProduct.platform, url: product.supplierProduct.url, storeName: product.supplierProduct.storeName, rating: product.supplierProduct.rating, orderCount: product.supplierProduct.orderCount }
        : null,
      variants: product.variants.map((v) => ({
        id: v.id,
        title: v.title,
        sku: v.sku ?? "",
        optionValues: v.optionValues as unknown as string[],
        image: v.image,
        cost: v.cost.toString(),
        price: v.price.toString(),
        compareAtPrice: v.compareAtPrice?.toString() ?? "",
        inventory: v.inventory,
        isEnabled: v.isEnabled,
        weightGrams: v.weightGrams,
        supplierStock: v.supplierVariant?.stock ?? null,
        supplierAvailable: v.supplierVariant?.isAvailable ?? true,
      })),
    },
    rules: rules.map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault })),
    collections,
    shipping,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, graphql, actor } = await requireShop(request);
  const { intent, get, json } = await readForm(request);
  const id = params.id!;
  try {
    switch (intent) {
      case "save": {
        await updateImportedProduct(shop.id, id, {
          title: get("title"),
          description: get("description"),
          vendor: get("vendor") || null,
          productType: get("productType") || null,
          tags: get("tags").split(",").map((t) => t.trim()).filter(Boolean),
          handle: get("handle") || null,
          collections: json<string[]>("collections", []),
          images: json<string[]>("images", []),
          excludedValues: json<Record<string, string[]>>("excludedValues", {}),
        });
        await updateImportedVariants(shop.id, id, json<Array<{ id: string; price: string; compareAtPrice: string; sku: string; inventory: number; isEnabled: boolean }>>("variants", []).map((v) => ({
          id: v.id,
          price: v.price,
          compareAtPrice: v.compareAtPrice || null,
          sku: v.sku || null,
          inventory: Number(v.inventory),
          isEnabled: v.isEnabled,
        })));
        return { ok: true, messageKey: "msg.saved" };
      }
      case "apply-rule":
        await applyPricingRuleToImport(shop.id, id, get("ruleId") || null);
        return { ok: true, messageKey: "msg.pricingRuleApplied" };
      case "push": {
        const result = await pushImportedProduct(shop, graphql, id, actor);
        if (result.ok) throw redirect(`/app/products/${result.productId}`);
        return { ok: false, error: result.error, errorKey: result.errorKey, errorVars: result.errorVars };
      }
      case "split": {
        const created = await splitImportedProduct(shop.id, id, get("option"));
        return { ok: true, messageKey: "msg.splitInto", messageVars: { n: created.length }, redirectTo: "/app/import" };
      }
      case "remove":
        await removeFromImportList(shop.id, [id]);
        throw redirect("/app/import");
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    if (e instanceof Response) throw e;
    return { ok: false, error: errorMessage(e) };
  }
};

type Product = Awaited<ReturnType<typeof loader>>["product"];
type Variant = Product["variants"][number];
type ModalState = { kind: "remove" } | { kind: "split"; option: string } | null;

export default function ImportEditPage() {
  const t = useT();
  const { product, rules, collections, shipping, currency, country } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const actionMessage = useMessage(fetcher.data as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(fetcher.data as Parameters<typeof useErrorMessage>[0]);
  const navigate = useNavigate();
  const [form, setForm] = useState({ title: product.title, description: product.description, vendor: product.vendor, productType: product.productType, tags: product.tags, handle: product.handle });
  const [collectionsSel, setCollectionsSel] = useState<string[]>(product.collections);
  const [images, setImages] = useState<string[]>(product.images);
  const [newImage, setNewImage] = useState("");
  const [excluded, setExcluded] = useState<Record<string, string[]>>(product.excludedValues);
  const [variants, setVariants] = useState(product.variants);
  const [ruleId, setRuleId] = useState(product.pricingRuleId);
  const [bulkPrice, setBulkPrice] = useState("");
  const [modal, setModal] = useState<ModalState>(null);

  const busy = fetcher.state !== "idle";
  const pendingIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const savedToast = fetcher.data && "messageKey" in fetcher.data && fetcher.data.messageKey === "msg.saved";

  // In an effect: calling navigate() from the render body updates the router
  // while another component is rendering, and runs twice under StrictMode, so
  // a split pushed two history entries.
  const redirectTo = fetcher.data && "redirectTo" in fetcher.data ? fetcher.data.redirectTo : null;
  useEffect(() => {
    if (redirectTo) navigate(redirectTo);
  }, [redirectTo, navigate]);

  // "Saved." is a toast, not a banner the merchant has to dismiss; anything
  // else stays a banner. A successful outcome also closes whichever
  // confirmation modal launched it.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (savedToast && actionMessage) shopify.toast.show(actionMessage);
    if (fetcher.data.ok) {
      setModal(null);
      reloadRef.current = pendingReload.current;
    }
    pendingReload.current = null;
  }, [fetcher.state, fetcher.data, savedToast, actionMessage, shopify]);

  // Applying a pricing rule and saving both change what the server holds, so
  // the fields are reloaded from the loader once it revalidates — but only
  // then, or a background revalidation would wipe half-typed edits.
  // `pendingReload` is what the click asked for; `reloadRef` is armed only once
  // the server has confirmed it. Arming on the click meant a save that failed
  // still reset the fields from the loader on the next revalidation, throwing
  // away everything the merchant had just typed.
  const pendingReload = useRef<"all" | "variants" | null>(null);
  const reloadRef = useRef<"all" | "variants" | null>(null);
  useEffect(() => {
    const mode = reloadRef.current;
    if (!mode) return;
    reloadRef.current = null;
    setVariants(product.variants);
    if (mode === "all") {
      setForm({ title: product.title, description: product.description, vendor: product.vendor, productType: product.productType, tags: product.tags, handle: product.handle });
      setCollectionsSel(product.collections);
      setImages(product.images);
      setExcluded(product.excludedValues);
    }
  }, [product]);

  const save = () => {
    pendingReload.current = "all";
    fetcher.submit(
      {
        intent: "save",
        ...form,
        collections: JSON.stringify(collectionsSel),
        images: JSON.stringify(images),
        excludedValues: JSON.stringify(excluded),
        variants: JSON.stringify(variants.map((v) => ({ id: v.id, price: v.price, compareAtPrice: v.compareAtPrice, sku: v.sku, inventory: v.inventory, isEnabled: v.isEnabled }))),
      },
      { method: "post" },
    );
  };
  const applyRule = () => {
    pendingReload.current = "variants";
    fetcher.submit({ intent: "apply-rule", ruleId }, { method: "post" });
  };

  const updateVariant = (id: string, patch: Partial<Variant>) => setVariants((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const optionValues = (index: number) => [...new Set(variants.map((v) => v.optionValues[index]).filter(Boolean))];
  const isExcluded = (v: Variant) => product.options.some((name, i) => (excluded[name] ?? []).includes(v.optionValues[i]));

  // Save is only meaningful when something differs from what the server holds.
  const initialSnapshot = useMemo(() => snapshot(product, product.variants), [product]);
  const dirty = snapshot({ ...form, collections: collectionsSel, images, excludedValues: excluded }, variants) !== initialSnapshot;

  const onSale = variants.filter((v) => v.isEnabled && !isExcluded(v));
  const excludedCount = variants.filter((v) => isExcluded(v)).length;
  const summary = summarize(onSale);

  return (
    <Page
      backAction={{ url: "/app/import" }}
      title={product.title}
      subtitle={t("import.editor.subtitle")}
      titleMetadata={<StatusBadge status={product.status} />}
      primaryAction={{
        content: t("action.push"),
        onAction: () => fetcher.submit({ intent: "push" }, { method: "post" }),
        loading: pendingIntent === "push",
        disabled: product.status === "PUSHED" || busy,
      }}
      secondaryActions={[
        { content: t("action.save"), onAction: save, loading: pendingIntent === "save", disabled: !dirty || busy },
        { content: t("action.remove"), destructive: true, onAction: () => setModal({ kind: "remove" }), disabled: busy },
      ]}
    >
      <Layout>
        {((actionMessage && !savedToast) || failureMessage) && (
          <Layout.Section>
            <BlockStack gap="300">
              {actionMessage && !savedToast && (
                <Banner tone="success">
                  <p>{actionMessage}</p>
                </Banner>
              )}
              {failureMessage && (
                <Banner tone="critical">
                  <p>{failureMessage}</p>
                </Banner>
              )}
            </BlockStack>
          </Layout.Section>
        )}

        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <SectionHeader title={t("import.editor.section.details")} />
                <FormLayout>
                  <TextField label={t("import.field.title")} value={form.title} onChange={(v) => setForm({ ...form, title: v })} autoComplete="off" maxLength={255} showCharacterCount />
                  <FormLayout.Group>
                    <TextField label={t("import.field.vendor")} value={form.vendor} onChange={(v) => setForm({ ...form, vendor: v })} autoComplete="off" />
                    <TextField label={t("import.field.productType")} value={form.productType} onChange={(v) => setForm({ ...form, productType: v })} autoComplete="off" />
                  </FormLayout.Group>
                  <TextField label={t("import.field.tags")} value={form.tags} onChange={(v) => setForm({ ...form, tags: v })} autoComplete="off" helpText={t("import.field.tagsHelp")} />
                  <TextField label={t("import.field.handle")} value={form.handle} onChange={(v) => setForm({ ...form, handle: v })} autoComplete="off" helpText={t("import.field.handleHelp")} />
                  {collections.length > 0 && (
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="semibold">
                        {t("import.collections")}
                      </Text>
                      <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="100">
                        {collections.map((c) => (
                          <Checkbox key={c.id} label={c.title} checked={collectionsSel.includes(c.id)} onChange={(checked) => setCollectionsSel((s) => (checked ? [...s, c.id] : s.filter((x) => x !== c.id)))} />
                        ))}
                      </InlineGrid>
                    </BlockStack>
                  )}
                </FormLayout>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <SectionHeader title={t("import.tab.description")} />
                <TextField
                  label={t("import.field.description")}
                  value={form.description}
                  onChange={(v) => setForm({ ...form, description: v })}
                  multiline={12}
                  autoComplete="off"
                  helpText={t("import.editor.descriptionHelp")}
                />
                <BlockStack gap="200">
                  <Text as="p" fontWeight="semibold">
                    {t("import.preview")}
                  </Text>
                  <Box borderColor="border" borderWidth="025" borderRadius="200" padding="300">
                    <div dangerouslySetInnerHTML={{ __html: form.description }} />
                  </Box>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <SectionHeader title={t("import.tab.images")} count={images.length} />
                <TextField
                  label={t("import.addImageUrl")}
                  value={newImage}
                  onChange={setNewImage}
                  autoComplete="off"
                  connectedRight={
                    <Button
                      disabled={!newImage.trim()}
                      onClick={() => {
                        if (newImage.trim()) setImages((imgs) => [...imgs, newImage.trim()]);
                        setNewImage("");
                      }}
                    >
                      {t("action.add")}
                    </Button>
                  }
                />
                {images.length === 0 ? (
                  <EmptyScreen compact heading={t("import.editor.images.empty")} body={t("import.editor.images.emptyBody")} />
                ) : (
                  <InlineGrid columns={{ xs: 3, sm: 4, md: 6 }} gap="300">
                    {images.map((src, i) => (
                      <Box key={`${src}-${i}`} borderColor="border" borderWidth="025" borderRadius="200" padding="200">
                        <BlockStack gap="200" inlineAlign="center">
                          <Thumb src={src} alt={form.title} size="large" />
                          {i === 0 ? <Badge tone="info">{t("import.editor.images.featured")}</Badge> : <Badge>{String(i + 1)}</Badge>}
                          <InlineStack gap="100" wrap={false}>
                            <Button size="micro" icon={ChevronLeftIcon} accessibilityLabel={t("import.editor.images.moveEarlier")} disabled={i === 0} onClick={() => setImages((imgs) => swap(imgs, i, i - 1))} />
                            <Button size="micro" icon={DeleteIcon} tone="critical" accessibilityLabel={t("action.remove")} onClick={() => setImages((imgs) => imgs.filter((_, j) => j !== i))} />
                            <Button size="micro" icon={ChevronRightIcon} accessibilityLabel={t("import.editor.images.moveLater")} disabled={i === images.length - 1} onClick={() => setImages((imgs) => swap(imgs, i, i + 1))} />
                          </InlineStack>
                        </BlockStack>
                      </Box>
                    ))}
                  </InlineGrid>
                )}
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("import.featuredImageHint")}
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <SectionHeader title={t("common.variants")} count={variants.length} />
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("import.editor.stat.variantsHint", { enabled: onSale.length, total: variants.length })}
                  {excludedCount > 0 ? ` · ${t("import.editor.variants.excludedHint", { n: excludedCount })}` : ""}
                </Text>

                <BlockStack gap="200">
                  <Text as="p" fontWeight="semibold">
                    {t("import.editor.variants.bulkPricing")}
                  </Text>
                  <InlineStack gap="300" blockAlign="end" wrap>
                    <Select label={t("import.pricingRule")} options={[{ label: t("import.builtInDefault"), value: "" }, ...rules.map((r) => ({ label: r.name, value: r.id }))]} value={ruleId} onChange={setRuleId} />
                    <Button onClick={applyRule} loading={pendingIntent === "apply-rule"} disabled={busy}>
                      {t("import.applyRuleAllVariants")}
                    </Button>
                    <TextField label={t("import.setAllPricesTo")} value={bulkPrice} onChange={setBulkPrice} type="number" autoComplete="off" prefix={currency} />
                    <Button
                      disabled={!bulkPrice}
                      onClick={() => {
                        setVariants((vs) => vs.map((v) => ({ ...v, price: Number(bulkPrice).toFixed(2) })));
                        setBulkPrice("");
                      }}
                    >
                      {t("action.apply")}
                    </Button>
                  </InlineStack>
                </BlockStack>

                {product.options.length > 0 && (
                  <BlockStack gap="200">
                    <Text as="p" fontWeight="semibold">
                      {t("import.excludeOptionValues")}
                    </Text>
                    {product.options.map((name, i) => (
                      <InlineStack key={name} gap="200" blockAlign="center" wrap>
                        <Text as="span" tone="subdued">
                          {name}:
                        </Text>
                        {optionValues(i).map((value) => (
                          <Checkbox
                            key={value}
                            label={value}
                            checked={!(excluded[name] ?? []).includes(value)}
                            onChange={(checked) =>
                              setExcluded((e) => ({ ...e, [name]: checked ? (e[name] ?? []).filter((x) => x !== value) : [...(e[name] ?? []), value] }))
                            }
                          />
                        ))}
                        <Button size="slim" onClick={() => setModal({ kind: "split", option: name })} disabled={busy}>
                          {t("import.splitBy")} {name}
                        </Button>
                      </InlineStack>
                    ))}
                  </BlockStack>
                )}

                <Divider />

                {variants.length === 0 ? (
                  <EmptyScreen compact heading={t("import.editor.variants.empty")} body={t("import.editor.variants.emptyBody")} />
                ) : (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "text", "numeric"]}
                    headings={[t("import.column.product"), t("common.cost"), t("common.price"), t("import.field.compareAt"), t("import.margin"), t("import.field.sku"), t("import.field.inventory")]}
                    verticalAlign="middle"
                    rows={variants.map((v) => {
                      const off = isExcluded(v);
                      const price = Number(v.price);
                      const margin = price > 0 ? ((price - Number(v.cost)) / price) * 100 : 0;
                      return [
                        <InlineStack key={`${v.id}-product`} gap="200" blockAlign="center" wrap={false}>
                          <Checkbox label={t("import.editor.variants.includeVariant")} labelHidden checked={v.isEnabled && !off} disabled={off} onChange={(checked) => updateVariant(v.id, { isEnabled: checked })} />
                          <Thumb src={v.image} alt={v.title} />
                          <BlockStack gap="050">
                            <Text as="span" fontWeight="semibold" tone={off || !v.isEnabled ? "subdued" : undefined}>
                              {v.title}
                            </Text>
                            {v.supplierStock !== null && (
                              <InlineStack>
                                <Badge tone={v.supplierAvailable && v.supplierStock > 0 ? "success" : "critical"}>{`${t("common.stock")} ${v.supplierStock}`}</Badge>
                              </InlineStack>
                            )}
                          </BlockStack>
                        </InlineStack>,
                        <Text key={`${v.id}-cost`} as="span" numeric>
                          {formatMoney(v.cost, currency)}
                        </Text>,
                        <TextField key={`${v.id}-price`} label={t("common.price")} labelHidden type="number" value={v.price} onChange={(val) => updateVariant(v.id, { price: val })} autoComplete="off" prefix={currency} />,
                        <TextField key={`${v.id}-compare`} label={t("import.field.compareAt")} labelHidden type="number" value={v.compareAtPrice} onChange={(val) => updateVariant(v.id, { compareAtPrice: val })} autoComplete="off" prefix={currency} />,
                        <MarginText key={`${v.id}-margin`} value={margin} />,
                        <TextField key={`${v.id}-sku`} label={t("import.field.sku")} labelHidden value={v.sku} onChange={(val) => updateVariant(v.id, { sku: val })} autoComplete="off" />,
                        <TextField key={`${v.id}-inventory`} label={t("import.field.inventory")} labelHidden type="number" value={String(v.inventory)} onChange={(val) => updateVariant(v.id, { inventory: Number(val) })} autoComplete="off" />,
                      ];
                    })}
                  />
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <SectionHeader title={t("nav.shipping")} />
                <Text as="p" tone="subdued">
                  {t("import.editor.shipping.intro", { country })}
                </Text>
                {shipping.length === 0 ? (
                  <EmptyScreen compact heading={t("import.shipping.noQuotes")} body={t("import.editor.shipping.noQuotesBody")} />
                ) : (
                  <DataTable
                    columnContentTypes={["text", "numeric", "text", "text"]}
                    headings={[t("import.shipping.carrier"), t("common.cost"), t("import.shipping.delivery"), t("nav.tracking")]}
                    rows={shipping.map((s) => [
                      s.carrierName,
                      formatMoney(s.cost, s.currency),
                      s.minDeliveryDays && s.maxDeliveryDays ? `${s.minDeliveryDays}–${s.maxDeliveryDays} ${t("import.shipping.days")}` : "—",
                      s.hasTracking ? t("common.yes") : t("common.no"),
                    ])}
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <SectionHeader title={t("import.editor.section.pricing")} />
                <InlineGrid columns={{ xs: 2 }} gap="400">
                  <Stat plain size="medium" label={t("import.editor.stat.cost")} value={summary ? moneyRange(summary.minCost, summary.maxCost, currency) : "—"} />
                  <Stat plain size="medium" label={t("import.editor.stat.price")} value={summary ? moneyRange(summary.minPrice, summary.maxPrice, currency) : "—"} />
                  <Stat
                    plain
                    size="medium"
                    label={t("import.editor.stat.margin")}
                    value={summary ? formatPercent(summary.avgMargin) : "—"}
                    tone={summary ? marginTone(summary.avgMargin) : "subdued"}
                  />
                  <Stat
                    plain
                    size="medium"
                    label={t("import.editor.stat.profit")}
                    value={summary ? moneyRange(summary.minProfit, summary.maxProfit, currency) : "—"}
                    tone={summary && summary.minProfit < 0 ? "critical" : "default"}
                  />
                </InlineGrid>
                <Text as="p" tone="subdued" variant="bodySm">
                  {summary ? t("import.editor.stat.variantsHint", { enabled: onSale.length, total: variants.length }) : t("import.editor.stat.noVariants")}
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  <Text as="h2" variant="headingMd">
                    {t("common.status")}
                  </Text>
                  <InlineStack gap="200">
                    {dirty && <Badge tone="attention">{t("import.editor.unsaved")}</Badge>}
                    <StatusBadge status={product.status} />
                  </InlineStack>
                </InlineStack>
                <Text as="p" tone="subdued">
                  {t(`import.editor.status.${product.status}`)}
                </Text>
                {dirty && (
                  <Text as="p" tone="caution">
                    {t("import.editor.unsavedHint")}
                  </Text>
                )}
                {product.pushError && product.status === "FAILED" && (
                  <Banner tone="critical" title={t("import.detail.pushFailed")}>
                    <p>{product.pushError}</p>
                  </Banner>
                )}
                {product.status === "PUSHED" && product.pushedProductId && (
                  <InlineStack>
                    <Button url={`/app/products/${product.pushedProductId}`}>{t("import.detail.openProduct")}</Button>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("common.supplier")} />
                {product.supplier ? (
                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <PlatformBadge platform={product.supplier.platform} />
                      {product.supplier.storeName && <Text as="span">{product.supplier.storeName}</Text>}
                    </InlineStack>
                    <InlineStack gap="200">
                      {product.supplier.rating ? <Badge>{`★ ${product.supplier.rating.toFixed(1)}`}</Badge> : null}
                      {product.supplier.orderCount ? <Badge>{`${product.supplier.orderCount.toLocaleString()} ${t("import.supplier.orders")}`}</Badge> : null}
                    </InlineStack>
                    {product.supplier.url && (
                      <InlineStack>
                        <Button url={product.supplier.url} external size="slim">
                          {t("import.supplier.openPage")}
                        </Button>
                      </InlineStack>
                    )}
                  </BlockStack>
                ) : (
                  <Text as="p" tone="subdued">
                    {t("import.supplier.notLinked")}
                  </Text>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={modal?.kind === "remove"}
        onClose={() => setModal(null)}
        title={t("import.editor.removeModal.title")}
        primaryAction={{ content: t("action.remove"), destructive: true, onAction: () => fetcher.submit({ intent: "remove" }, { method: "post" }), loading: pendingIntent === "remove" }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setModal(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t("import.editor.removeModal.body")}</Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={modal?.kind === "split"}
        onClose={() => setModal(null)}
        title={t("import.editor.splitModal.title", { option: modal?.kind === "split" ? modal.option : "" })}
        primaryAction={{
          content: t("import.editor.splitModal.confirm"),
          onAction: () => {
            if (modal?.kind === "split") fetcher.submit({ intent: "split", option: modal.option }, { method: "post" });
          },
          loading: pendingIntent === "split",
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setModal(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t("import.editor.splitModal.body", { option: modal?.kind === "split" ? modal.option : "" })}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

function swap<T>(arr: T[], a: number, b: number): T[] {
  const next = [...arr];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/** Everything the Save action sends, in one comparable string. */
function snapshot(
  fields: { title: string; description: string; vendor: string; productType: string; tags: string; handle: string; collections: string[]; images: string[]; excludedValues: Record<string, string[]> },
  variants: Variant[],
) {
  return JSON.stringify({
    title: fields.title,
    description: fields.description,
    vendor: fields.vendor,
    productType: fields.productType,
    tags: fields.tags,
    handle: fields.handle,
    collections: fields.collections,
    images: fields.images,
    excludedValues: fields.excludedValues,
    variants: variants.map((v) => ({ id: v.id, price: v.price, compareAtPrice: v.compareAtPrice, sku: v.sku, inventory: v.inventory, isEnabled: v.isEnabled })),
  });
}

/**
 * The figures for the pricing summary, from the variants as they are being
 * edited rather than as saved, so a price change shows its margin at once.
 */
function summarize(rows: Array<{ cost: string; price: string }>) {
  if (rows.length === 0) return null;
  const costs = rows.map((r) => Number(r.cost) || 0);
  const prices = rows.map((r) => Number(r.price) || 0);
  const profits = rows.map((_, i) => prices[i] - costs[i]);
  const margins = rows.map((_, i) => (prices[i] > 0 ? (profits[i] / prices[i]) * 100 : 0));
  return {
    minCost: Math.min(...costs),
    maxCost: Math.max(...costs),
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
    minProfit: Math.min(...profits),
    maxProfit: Math.max(...profits),
    avgMargin: margins.reduce((a, b) => a + b, 0) / margins.length,
  };
}

/** "$1.00 – $3.00", or a single figure when every variant is the same. */
function moneyRange(min: number, max: number, currency: string) {
  return min === max ? formatMoney(min, currency) : `${formatMoney(min, currency)} – ${formatMoney(max, currency)}`;
}
