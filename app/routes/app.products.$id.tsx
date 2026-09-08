import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import type { MappingType } from "@prisma/client";
import type { ResolveResult } from "~/domain/mapping/types";
import { FAILURE_LABELS } from "~/domain/mapping/resolve";
import { readForm, requireShop } from "~/lib/auth.server";
import { actionFailure } from "~/lib/errors";
import { adminUrl, formatMoney, legacyId, relativeTime } from "~/lib/format";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
import { addSupplierProductForMapping, getMapping, getSupplierProductWithVariants, resolveForVariant, saveMapping, suggestMappingForProduct, supplierProductsForProduct, type MappingRowInput, type MappingSuggestionRow } from "~/services/mapping.server";
import { aiMappingAvailable } from "~/services/ai-mapping.server";
import { requireFeature } from "~/services/billing.server";
import { dismissCandidate, findAlternativeSuppliers, getComparison, switchSupplier } from "~/services/supplier-comparison.server";
import { listPricingRules } from "~/services/pricing.server";
import { deleteProducts, getProduct, repriceProduct, setAutoUpdate, syncProductFromShopify } from "~/services/products.server";
import { priceHistory } from "~/services/suppliers/catalog.server";

/** Translation keys for the help text under the mapping type selector. */
const MAPPING_HELP = {
  BASIC: "products.mapping.help.basic",
  ADVANCED: "products.mapping.help.advanced",
  BOGO: "products.mapping.help.bogo",
  BUNDLE: "products.mapping.help.bundle",
} as const satisfies Record<MappingType, string>;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const product = await getProduct(shop.id, params.id!);
  if (!product) throw new Response("Not found", { status: 404 });
  const [mapping, pool, rules, comparison] = await Promise.all([
    getMapping(product.id),
    supplierProductsForProduct(product.id),
    listPricingRules(shop.id),
    getComparison(shop, product.id),
  ]);

  // Extra supplier products added this session (via ?supplier=id) but not yet mapped.
  const extraIds = (url.searchParams.get("suppliers") ?? "").split(",").filter(Boolean);
  const extras = (await Promise.all(extraIds.map((id) => getSupplierProductWithVariants(id)))).filter((p): p is NonNullable<typeof p> => Boolean(p));
  const supplierProducts = [...pool, ...extras.filter((e) => !pool.some((p) => p.id === e.id))];

  // Cost history for the first mapped variant, for the sidebar.
  const firstRow = mapping?.variants[0];
  const history = firstRow ? await priceHistory(firstRow.supplierVariant.supplierProductId, firstRow.supplierVariant.externalSkuId, 12) : [];

  return {
    shopDomain: shop.domain,
    currency: shop.currency,
    country: shop.country ?? "US",
    loadedSuppliers: extraIds,
    loadedMessage: url.searchParams.get("loaded"),
    aiAvailable: aiMappingAvailable(),
    comparison: {
      shipToCountry: comparison.shipToCountry,
      evaluatedAt: comparison.evaluatedAt,
      betterOptionId: comparison.betterOption?.supplierProductId ?? null,
      rows: comparison.rows.map((r) => ({
        supplierProductId: r.supplierProductId,
        platform: r.platform,
        title: r.title,
        url: r.url,
        image: r.image,
        storeName: r.storeName,
        itemCost: String(r.itemCost),
        shippingCost: String(r.shippingCost),
        landedCost: r.landedCost,
        currency: r.currency,
        deliveryDays: r.deliveryDays,
        carrierName: r.carrierName,
        rating: r.rating,
        orderCount: r.orderCount,
        score: r.score,
        savingsVsCurrent: r.savingsVsCurrent,
        savingsPercent: r.savingsPercent,
        isCurrent: Boolean(r.isCurrent),
        isBest: r.isBest,
        isAvailable: r.isAvailable,
        matchedVariants: r.matchedVariants,
        totalVariants: r.totalVariants,
        dismissed: r.dismissed,
      })),
    },
    product: {
      id: product.id,
      title: product.title,
      status: product.status,
      image: product.featuredImage,
      shopifyProductId: product.shopifyProductId,
      autoUpdate: product.autoUpdateEnabled,
      lastSyncedAt: product.lastSyncedAt,
      variants: product.variants.map((v) => ({ id: v.id, title: v.title, sku: v.sku, price: v.price.toString(), cost: v.cost?.toString() ?? null, inventory: v.inventoryQuantity, optionValues: v.optionValues as unknown as string[] })),
    },
    mapping: mapping
      ? {
          type: mapping.type,
          isEnabled: mapping.isEnabled,
          notes: mapping.notes ?? "",
          rows: mapping.variants.map((r) => ({
            productVariantId: r.productVariantId,
            supplierVariantId: r.supplierVariantId,
            supplierProductId: r.supplierVariant.supplierProductId,
            quantity: r.quantity,
            priority: r.priority,
            shipToCountry: r.shipToCountry,
            minQuantity: r.minQuantity,
            maxQuantity: r.maxQuantity,
            bundleGroup: r.bundleGroup,
            isDefault: r.isDefault,
            isEnabled: r.isEnabled,
            source: r.source,
            confidence: r.confidence,
          })),
        }
      : { type: "BASIC" as MappingType, isEnabled: true, notes: "", rows: [] },
    supplierProducts: supplierProducts.map((sp) => ({
      id: sp.id,
      platform: sp.platform,
      externalId: sp.externalId,
      title: sp.title,
      url: sp.url,
      storeName: sp.storeName,
      image: sp.images[0] ?? null,
      isAvailable: sp.isAvailable,
      variants: sp.variants.map((v) => ({
        id: v.id,
        label: ((v.attributes as unknown as Array<{ value: string }>) ?? []).map((a) => a.value).join(" / ") || v.externalSkuId,
        price: v.price.toString(),
        currency: v.currency,
        stock: v.stock,
        isAvailable: v.isAvailable,
        image: v.image,
      })),
    })),
    rules: rules.map((r) => ({ id: r.id, name: r.name })),
    history: history.map((h) => ({ at: h.capturedAt, price: h.price.toString(), stock: h.stock })).reverse(),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, graphql, actor } = await requireShop(request);
  const { intent, get, json } = await readForm(request);
  const id = params.id!;
  try {
    switch (intent) {
      case "save-mapping": {
        await saveMapping(shop.id, id, { type: get("type") as MappingType, isEnabled: get("isEnabled") !== "false", notes: get("notes") || null, rows: json<MappingRowInput[]>("rows", []) }, actor);
        return { ok: true, messageKey: "msg.mappingSaved" };
      }
      case "add-supplier": {
        const sp = await addSupplierProductForMapping(shop.id, get("reference"));
        // Keep the freshly loaded supplier in the URL so the loader includes its SKUs.
        const existing = get("suppliers").split(",").filter(Boolean);
        const suppliers = [...new Set([...existing, sp.id])].join(",");
        throw redirect(`/app/products/${id}?suppliers=${suppliers}&loaded=${encodeURIComponent(sp.title)}`);
      }
      case "auto-map": {
        const useAi = get("useAi") === "true";
        if (useAi) await requireFeature(shop, "aiMapping");
        const suggestion = await suggestMappingForProduct(id, get("supplierProductId"), { useAi, shopId: shop.id });
        // The pieces are translated on the page; the action only says which
        // ones apply and with what numbers.
        return {
          ok: true,
          messageKey: suggestion.unresolved ? "msg.autoMappedUnresolved" : "msg.autoMapped",
          messageVars: { n: suggestion.rows.length, unresolved: suggestion.unresolved },
          aiUsed: suggestion.aiUsed,
          aiError: suggestion.aiError,
          autoRows: suggestion.rows,
        };
      }
      case "compare-suppliers": {
        const result = await findAlternativeSuppliers(shop, id, { actor });
        if (result.rows.length === 0) return { ok: true, messageKey: "msg.noComparableSuppliers" };
        return result.betterOption
          ? {
              ok: true,
              messageKey: "msg.comparedWithBetter",
              messageVars: { n: result.rows.length, saving: String(result.betterOption.savingsVsCurrent) },
            }
          : { ok: true, messageKey: "msg.comparedCurrentBest", messageVars: { n: result.rows.length } };
      }
      case "switch-supplier": {
        const suggestion = await switchSupplier(shop, id, get("supplierProductId"), actor);
        return suggestion.unresolved
          ? { ok: true, messageKey: "msg.supplierSwitchedUnresolved", messageVars: { n: suggestion.rows.length, unresolved: suggestion.unresolved } }
          : { ok: true, messageKey: "msg.supplierSwitched", messageVars: { n: suggestion.rows.length } };
      }
      case "dismiss-candidate": {
        await dismissCandidate(shop, id, get("supplierProductId"));
        return { ok: true, messageKey: "msg.candidateHidden" };
      }
      case "preview": {
        const product = await getProduct(shop.id, id);
        const qty = Math.max(1, Number(get("quantity") || 1));
        const country = get("country") || "US";
        const preview: Array<{ variantId: string; title: string; result: ResolveResult }> = [];
        for (const v of product?.variants ?? []) preview.push({ variantId: v.id, title: v.title, result: await resolveForVariant(v.id, country, qty) });
        return { ok: true, preview };
      }
      case "reprice": {
        const n = await repriceProduct(shop, graphql, id, get("ruleId") || null, actor);
        return { ok: true, messageKey: "msg.variantsRepriced", messageVars: { n } };
      }
      case "toggle-auto": {
        await setAutoUpdate(shop.id, [id], get("enabled") === "true");
        return { ok: true, messageKey: get("enabled") === "true" ? "msg.autoUpdateEnabledOne" : "msg.autoUpdateDisabledOne" };
      }
      case "refresh": {
        const product = await getProduct(shop.id, id);
        if (product) await syncProductFromShopify(shop, graphql, product.shopifyProductId);
        return { ok: true, messageKey: "msg.refreshedFromShopify" };
      }
      case "delete": {
        await deleteProducts(shop, graphql, [id], { alsoInShopify: get("alsoInShopify") === "true" }, actor);
        throw redirect("/app/products");
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    if (e instanceof Response) throw e;
    return actionFailure(e);
  }
};

type Row = {
  key: string;
  productVariantId: string;
  supplierProductId: string;
  supplierVariantId: string;
  quantity: number;
  priority: number;
  shipToCountry: string;
  minQuantity: number | null;
  maxQuantity: number | null;
  bundleGroup: string | null;
  isDefault: boolean;
  isEnabled: boolean;
  source?: "MANUAL" | "AUTO" | "AI";
  confidence?: number | null;
};

export default function ProductDetailPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const previewFetcher = useFetcher<typeof action>();
  const [type, setType] = useState<MappingType>(data.mapping.type);
  const [enabled, setEnabled] = useState(data.mapping.isEnabled);
  const [notes, setNotes] = useState(data.mapping.notes);
  const [rows, setRows] = useState<Row[]>(data.mapping.rows.map((r, i) => ({ key: `r${i}`, ...r })));
  const [supplierRef, setSupplierRef] = useState("");
  const [previewCountry, setPreviewCountry] = useState(data.country);
  const [previewQty, setPreviewQty] = useState("1");
  const [ruleId, setRuleId] = useState("");

  const result = fetcher.data as { ok?: boolean; message?: string; error?: string; aiUsed?: boolean; aiError?: string | null; autoRows?: MappingSuggestionRow[] } | undefined;

  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(result as Parameters<typeof useErrorMessage>[0]);

  // Suggestions fill the gaps; they never replace rows the merchant built.
  // Applying them in the render body replaced the whole table (losing hand-made
  // mappings), then went silent for every later suggestion, and re-inserted the
  // whole set as soon as the last auto row was deleted.
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const appliedRef = useRef<unknown>(null);
  useEffect(() => {
    const auto = result?.autoRows;
    if (!auto || auto.length === 0) return;
    if (appliedRef.current === result) return;
    appliedRef.current = result;

    setRows((current) => {
      const alreadyMapped = new Set(current.map((r) => r.productVariantId));
      const additions = auto
        .filter((r) => !alreadyMapped.has(r.productVariantId))
        .map((r, i) => ({
          key: `auto${Date.now()}-${i}`,
          productVariantId: r.productVariantId,
          supplierProductId: data.supplierProducts.find((sp) => sp.variants.some((v) => v.id === r.supplierVariantId))?.id ?? "",
          supplierVariantId: r.supplierVariantId,
          quantity: 1,
          priority: 0,
          shipToCountry: "*",
          minQuantity: null,
          maxQuantity: null,
          bundleGroup: null,
          isDefault: true,
          isEnabled: true,
          source: r.source,
          confidence: r.confidence,
        }));
      const skipped = auto.length - additions.length;
      setAutoNote(
        additions.length === 0
          ? t("products.autoMap.nothingChanged")
          : `${t("products.autoMap.added")} ${additions.length}${skipped ? ` · ${skipped} ${t("products.autoMap.skipped")}` : ""}. ${t("products.autoMap.saveReminder")}`,
      );
      return additions.length ? [...current, ...additions] : current;
    });
  }, [result, data.supplierProducts, t]);

  const supplierById = useMemo(() => new Map(data.supplierProducts.map((sp) => [sp.id, sp])), [data.supplierProducts]);
  const rowsFor = (variantId: string) => rows.filter((r) => r.productVariantId === variantId);
  const addRow = (variantId: string) =>
    setRows((rs) => [
      ...rs,
      { key: `n${Date.now()}${Math.random()}`, productVariantId: variantId, supplierProductId: data.supplierProducts[0]?.id ?? "", supplierVariantId: data.supplierProducts[0]?.variants[0]?.id ?? "", quantity: 1, priority: rowsFor(variantId).length, shipToCountry: "*", minQuantity: type === "BOGO" ? 1 : null, maxQuantity: null, bundleGroup: type === "BUNDLE" ? "default" : null, isDefault: rowsFor(variantId).length === 0, isEnabled: true },
    ]);
  const updateRow = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));

  const save = () =>
    fetcher.submit(
      {
        intent: "save-mapping",
        type,
        isEnabled: String(enabled),
        notes,
        rows: JSON.stringify(rows.filter((r) => r.supplierVariantId).map(({ key: _k, supplierProductId: _s, ...r }) => r)),
      },
      { method: "post" },
    );

  const preview = (previewFetcher.data as { preview?: Array<{ variantId: string; title: string; result: ResolveResult }> } | undefined)?.preview;

  return (
    <Page
      backAction={{ url: "/app/products" }}
      title={data.product.title}
      titleMetadata={<StatusBadge status={data.product.status} />}
      primaryAction={{ content: t("products.action.saveMapping"), onAction: save, loading: fetcher.state !== "idle" }}
      secondaryActions={[
        { content: t("products.action.openInShopify"), url: adminUrl(data.shopDomain, `/products/${legacyId(data.product.shopifyProductId)}`), external: true },
        { content: t("products.action.refreshFromShopify"), onAction: () => fetcher.submit({ intent: "refresh" }, { method: "post" }) },
        { content: data.product.autoUpdate ? t("products.action.disableAutoUpdate") : t("products.action.enableAutoUpdate"), onAction: () => fetcher.submit({ intent: "toggle-auto", enabled: String(!data.product.autoUpdate) }, { method: "post" }) },
        { content: t("products.action.unlinkFromApp"), destructive: true, onAction: () => fetcher.submit({ intent: "delete", alsoInShopify: "false" }, { method: "post" }) },
      ]}
    >
      <Layout>
        <Layout.Section>
          {data.loadedMessage && (
            <Banner tone="success">
              <p>
                “{data.loadedMessage}” — {t("products.supplierLoaded")}
              </p>
            </Banner>
          )}
          {actionMessage && (
            <Banner tone="success">
              <p>
                {actionMessage}
                {result?.aiUsed ? ` ${t("msg.autoMapAiUsed")}` : ""}
                {result?.aiError ? ` ${t("msg.autoMapAiUnavailable")}: ${result.aiError}` : ""}
              </p>
            </Banner>
          )}
          {autoNote && (
            <Banner tone="info" onDismiss={() => setAutoNote(null)}>
              <p>{autoNote}</p>
            </Banner>
          )}
          {failureMessage && (
            <Banner tone="critical">
              <p>{failureMessage}</p>
            </Banner>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  {t("products.mapping.title")}
                </Text>
                <Checkbox label={t("products.mapping.enabled")} checked={enabled} onChange={setEnabled} />
              </InlineStack>
              <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="300">
                <Select
                  label={t("products.mapping.typeLabel")}
                  value={type}
                  onChange={(v) => setType(v as MappingType)}
                  options={[
                    { label: t("products.mapping.type.basic"), value: "BASIC" },
                    { label: t("products.mapping.type.advanced"), value: "ADVANCED" },
                    { label: t("products.mapping.type.bogo"), value: "BOGO" },
                    { label: t("products.mapping.type.bundle"), value: "BUNDLE" },
                  ]}
                />
                <Box paddingBlockStart="600">
                  <Text as="p" tone="subdued">
                    {t(MAPPING_HELP[type])}
                  </Text>
                </Box>
              </InlineGrid>

              <Divider />
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  {t("products.supplierProducts")}
                </Text>
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    <TextField label={t("products.addSupplier.label")} value={supplierRef} onChange={setSupplierRef} autoComplete="off" placeholder="https://www.aliexpress.com/item/1005006001.html" />
                  </div>
                  <Button onClick={() => fetcher.submit({ intent: "add-supplier", reference: supplierRef, suppliers: data.loadedSuppliers.join(",") }, { method: "post" })} disabled={!supplierRef.trim()} loading={fetcher.state !== "idle"}>
                    {t("products.action.load")}
                  </Button>
                </InlineStack>
                {data.supplierProducts.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {t("products.noSupplierLoaded")}
                  </Text>
                ) : (
                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="200">
                    {data.supplierProducts.map((sp) => (
                      <Box key={sp.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                        <InlineStack gap="300" blockAlign="start" wrap={false}>
                          <Thumb src={sp.image} alt={sp.title} />
                          <BlockStack gap="100">
                            <Text as="p" fontWeight="semibold">
                              {sp.title}
                            </Text>
                            <InlineStack gap="100">
                              <PlatformBadge platform={sp.platform} />
                              {!sp.isAvailable && <Badge tone="critical">{t("common.unavailable")}</Badge>}
                              <Badge>{`${sp.variants.length} SKUs`}</Badge>
                            </InlineStack>
                            <InlineStack gap="200" wrap>
                              <Button size="slim" onClick={() => fetcher.submit({ intent: "auto-map", supplierProductId: sp.id, useAi: "false" }, { method: "post" })}>
                                {t("action.autoMap")}
                              </Button>
                              <Button
                                size="slim"
                                variant="primary"
                                disabled={!data.aiAvailable}
                                loading={fetcher.state !== "idle"}
                                onClick={() => fetcher.submit({ intent: "auto-map", supplierProductId: sp.id, useAi: "true" }, { method: "post" })}
                              >
                                {data.aiAvailable ? t("action.matchWithAi") : t("products.aiNoKey")}
                              </Button>
                              {sp.url && (
                                <Button size="slim" url={sp.url} external>
                                  {t("common.open")}
                                </Button>
                              )}
                            </InlineStack>
                          </BlockStack>
                        </InlineStack>
                      </Box>
                    ))}
                  </InlineGrid>
                )}
              </BlockStack>

              <Divider />
              <BlockStack gap="300">
                {data.product.variants.map((variant) => (
                  <Box key={variant.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="050">
                          <Text as="p" fontWeight="semibold">
                            {variant.title}
                          </Text>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {variant.sku ? `SKU ${variant.sku} · ` : ""}
                            {t("common.price")} {formatMoney(variant.price, data.currency)} · {t("common.stock")} {variant.inventory}
                          </Text>
                        </BlockStack>
                        <Button size="slim" onClick={() => addRow(variant.id)} disabled={data.supplierProducts.length === 0 || (type === "BASIC" && rowsFor(variant.id).length >= 1)}>
                          {t("products.action.addSupplierOption")}
                        </Button>
                      </InlineStack>
                      {rowsFor(variant.id).length === 0 && (
                        <Text as="p" tone="critical" variant="bodySm">
                          {t("products.variantNotMapped")}
                        </Text>
                      )}
                      {rowsFor(variant.id).map((row) => {
                        const sp = supplierById.get(row.supplierProductId) ?? data.supplierProducts.find((p) => p.variants.some((v) => v.id === row.supplierVariantId));
                        const sv = sp?.variants.find((v) => v.id === row.supplierVariantId);
                        return (
                          <Box key={row.key} padding="200" background="bg-surface" borderRadius="200" borderColor="border" borderWidth="025">
                            <BlockStack gap="200">
                              <InlineGrid columns={{ xs: 1, md: type === "BASIC" ? 3 : 4 }} gap="200">
                                <Select
                                  label={t("products.row.supplierProduct")}
                                  value={sp?.id ?? ""}
                                  onChange={(v) => updateRow(row.key, { supplierProductId: v, supplierVariantId: supplierById.get(v)?.variants[0]?.id ?? "" })}
                                  options={data.supplierProducts.map((p) => ({ label: p.title.slice(0, 60), value: p.id }))}
                                />
                                <Select
                                  label={t("products.row.supplierSku")}
                                  value={row.supplierVariantId}
                                  onChange={(v) => updateRow(row.key, { supplierVariantId: v })}
                                  options={(sp?.variants ?? []).map((v) => ({ label: `${v.label} — ${formatMoney(v.price, v.currency)} · ${t("common.stock")} ${v.stock}`, value: v.id }))}
                                />
                                <TextField label={type === "BOGO" ? t("products.row.unitsToBuy") : t("products.row.qtyPerUnit")} type="number" min={1} value={String(row.quantity)} onChange={(v) => updateRow(row.key, { quantity: Math.max(1, Number(v)) })} autoComplete="off" />
                                {type === "ADVANCED" && (
                                  <TextField label={t("products.row.shipTo")} value={row.shipToCountry} onChange={(v) => updateRow(row.key, { shipToCountry: v.toUpperCase() })} autoComplete="off" />
                                )}
                                {type === "BOGO" && (
                                  <InlineGrid columns={2} gap="100">
                                    <TextField label={t("products.row.minQty")} type="number" value={String(row.minQuantity ?? 1)} onChange={(v) => updateRow(row.key, { minQuantity: Number(v) })} autoComplete="off" />
                                    <TextField label={t("products.row.maxQty")} type="number" value={row.maxQuantity === null ? "" : String(row.maxQuantity)} onChange={(v) => updateRow(row.key, { maxQuantity: v === "" ? null : Number(v) })} autoComplete="off" placeholder="∞" />
                                  </InlineGrid>
                                )}
                                {type === "BUNDLE" && <TextField label={t("products.row.bundleGroup")} value={row.bundleGroup ?? "default"} onChange={(v) => updateRow(row.key, { bundleGroup: v })} autoComplete="off" />}
                              </InlineGrid>
                              <InlineStack gap="300" blockAlign="center" align="space-between">
                                <InlineStack gap="300">
                                  {type !== "BASIC" && <TextField label={t("products.row.priority")} labelHidden type="number" value={String(row.priority)} onChange={(v) => updateRow(row.key, { priority: Number(v) })} autoComplete="off" prefix={t("products.row.priority")} />}
                                  {type === "ADVANCED" && <Checkbox label={t("products.row.default")} checked={row.isDefault} onChange={(c) => updateRow(row.key, { isDefault: c })} />}
                                  <Checkbox label={t("common.enabled")} checked={row.isEnabled} onChange={(c) => updateRow(row.key, { isEnabled: c })} />
                                  {sv && <Badge tone={sv.isAvailable && sv.stock > 0 ? "success" : "critical"}>{sv.isAvailable && sv.stock > 0 ? `${t("common.inStock")} (${sv.stock})` : t("common.outOfStock")}</Badge>}
                                  {row.source && row.source !== "MANUAL" && (
                                    <Badge tone={(row.confidence ?? 0) >= 0.9 ? "success" : "attention"}>
                                      {`${row.source === "AI" ? "AI" : t("products.row.autoSource")} ${Math.round((row.confidence ?? 0) * 100)}%`}
                                    </Badge>
                                  )}
                                </InlineStack>
                                <Button size="slim" tone="critical" onClick={() => removeRow(row.key)}>
                                  {t("action.remove")}
                                </Button>
                              </InlineStack>
                            </BlockStack>
                          </Box>
                        );
                      })}
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
              <TextField label={t("products.notes.label")} value={notes} onChange={setNotes} autoComplete="off" multiline={2} placeholder={t("products.notes.placeholder")} />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <BlockStack gap="050">
                  <Text as="h2" variant="headingMd">
                    {t("products.compare.title")}
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    {t("products.compare.landedCostNote")} {data.comparison.shipToCountry} ({data.currency}).
                    {data.comparison.evaluatedAt ? ` ${t("products.compare.lastChecked")} ${relativeTime(data.comparison.evaluatedAt)}.` : ""}
                  </Text>
                </BlockStack>
                <Button onClick={() => fetcher.submit({ intent: "compare-suppliers" }, { method: "post" })} loading={fetcher.state !== "idle"}>
                  {data.comparison.rows.length ? t("products.compare.recheck") : t("action.compareSuppliers")}
                </Button>
              </InlineStack>

              {data.comparison.betterOptionId && (
                <Banner tone="success" title={t("products.compare.betterAvailable")}>
                  <p>
                    {(() => {
                      const best = data.comparison.rows.find((r) => r.supplierProductId === data.comparison.betterOptionId);
                      return best
                        ? `${best.title.slice(0, 70)} — ${t("products.compare.saves")} ${formatMoney(best.savingsVsCurrent ?? 0, data.currency)} ${t("products.compare.perUnit")} (${best.savingsPercent}%), ${t("products.compare.covers")} ${best.matchedVariants}/${best.totalVariants} ${t("products.variantCount")}.`
                        : "";
                    })()}
                  </p>
                </Banner>
              )}

              {data.comparison.rows.length === 0 ? (
                <Text as="p" tone="subdued">
                  {t("products.compare.emptyBody")}
                </Text>
              ) : (
                <BlockStack gap="200">
                  {data.comparison.rows.filter((r) => !r.dismissed).map((row) => (
                    <Box
                      key={row.supplierProductId}
                      padding="300"
                      borderRadius="200"
                      borderColor={row.isCurrent ? "border-emphasis" : "border"}
                      borderWidth="025"
                      background={row.isBest && !row.isCurrent ? "bg-surface-success" : undefined}
                    >
                      <InlineGrid columns={{ xs: 1, md: ["twoThirds", "oneThird"] }} gap="300">
                        <InlineStack gap="300" blockAlign="start" wrap={false}>
                          <Thumb src={row.image} alt={row.title} />
                          <BlockStack gap="100">
                            <InlineStack gap="100" blockAlign="center" wrap>
                              <PlatformBadge platform={row.platform} />
                              {row.isCurrent && <Badge tone="info">{t("products.compare.current")}</Badge>}
                              {row.isBest && !row.isCurrent && <Badge tone="success">{t("products.compare.bestScore")}</Badge>}
                              {!row.isAvailable && <Badge tone="critical">{t("common.outOfStock")}</Badge>}
                              <Badge>{`${t("products.compare.score")} ${row.score}`}</Badge>
                            </InlineStack>
                            <Text as="p" fontWeight="semibold">
                              {row.title.slice(0, 90)}
                            </Text>
                            <Text as="p" tone="subdued" variant="bodySm">
                              {row.storeName ? `${row.storeName} · ` : ""}
                              {row.rating ? `★ ${row.rating.toFixed(1)} · ` : ""}
                              {row.orderCount ? `${row.orderCount.toLocaleString()} ${t("products.compare.orders")} · ` : ""}
                              {t("products.compare.covers")} {row.matchedVariants}/{row.totalVariants} {t("products.variantCount")}
                            </Text>
                            <Text as="p" variant="bodySm">
                              {t("products.compare.item")} {formatMoney(row.itemCost, data.currency)} + {t("common.shipping")} {formatMoney(row.shippingCost, data.currency)}
                              {row.carrierName ? ` (${row.carrierName}` : ""}
                              {row.deliveryDays ? `${row.carrierName ? ", " : " ("}${row.deliveryDays} ${t("products.compare.days")})` : row.carrierName ? ")" : ""}
                            </Text>
                          </BlockStack>
                        </InlineStack>
                        <BlockStack gap="200" inlineAlign="end">
                          <Text as="p" variant="headingMd">
                            {formatMoney(row.landedCost, data.currency)}
                          </Text>
                          {row.savingsVsCurrent && Number(row.savingsVsCurrent) > 0 && (
                            <Badge tone="success">{`${t("products.compare.saves")} ${formatMoney(row.savingsVsCurrent, data.currency)} (${row.savingsPercent}%)`}</Badge>
                          )}
                          {row.savingsVsCurrent && Number(row.savingsVsCurrent) < 0 && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              {formatMoney(Math.abs(Number(row.savingsVsCurrent)), data.currency)} {t("products.compare.dearer")}
                            </Text>
                          )}
                          <InlineStack gap="100">
                            {row.url && (
                              <Button size="slim" url={row.url} external>
                                {t("common.view")}
                              </Button>
                            )}
                            {!row.isCurrent && (
                              <>
                                <Button
                                  size="slim"
                                  variant="primary"
                                  disabled={!row.isAvailable || row.matchedVariants === 0}
                                  loading={fetcher.state !== "idle"}
                                  onClick={() => fetcher.submit({ intent: "switch-supplier", supplierProductId: row.supplierProductId }, { method: "post" })}
                                >
                                  {t("action.switchSupplier")}
                                </Button>
                                <Button size="slim" onClick={() => fetcher.submit({ intent: "dismiss-candidate", supplierProductId: row.supplierProductId }, { method: "post" })}>
                                  {t("products.compare.hide")}
                                </Button>
                              </>
                            )}
                          </InlineStack>
                        </BlockStack>
                      </InlineGrid>
                    </Box>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {t("products.test.title")}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("products.test.help")}
                </Text>
                <InlineGrid columns={2} gap="200">
                  <TextField label={t("products.test.shipTo")} value={previewCountry} onChange={(v) => setPreviewCountry(v.toUpperCase())} autoComplete="off" />
                  <TextField label={t("common.quantity")} type="number" value={previewQty} onChange={setPreviewQty} autoComplete="off" />
                </InlineGrid>
                <Button onClick={() => previewFetcher.submit({ intent: "preview", country: previewCountry, quantity: previewQty }, { method: "post" })} loading={previewFetcher.state !== "idle"}>
                  {t("action.preview")}
                </Button>
                {preview && (
                  <BlockStack gap="200">
                    {preview.map((p) => (
                      <Box key={p.variantId} padding="200" background="bg-surface-secondary" borderRadius="200">
                        <BlockStack gap="050">
                          <Text as="p" fontWeight="semibold">
                            {p.title}
                          </Text>
                          {p.result.ok ? (
                            p.result.lines.map((l) => (
                              <Text as="p" key={l.mappingRowId} variant="bodySm">
                                ✓ {l.quantity} × {l.title.slice(0, 50)} @ {formatMoney(l.unitCost, l.currency)}
                              </Text>
                            ))
                          ) : (
                            <Text as="p" tone="critical" variant="bodySm">
                              ✕ {p.result.failure ? FAILURE_LABELS[p.result.failure] : t("stage.FAILED")}: {p.result.reason}
                            </Text>
                          )}
                        </BlockStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {t("products.pricing.title")}
                </Text>
                <Select label={t("products.pricing.rule")} options={[{ label: t("products.pricing.defaultRule"), value: "" }, ...data.rules.map((r) => ({ label: r.name, value: r.id }))]} value={ruleId} onChange={setRuleId} />
                <Button onClick={() => fetcher.submit({ intent: "reprice", ruleId }, { method: "post" })}>{t("products.action.repriceFromCost")}</Button>
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("products.column.autoUpdate")}: {data.product.autoUpdate ? t("common.on") : t("common.off")} · {t("products.lastSync")} {relativeTime(data.product.lastSyncedAt)}
                </Text>
              </BlockStack>
            </Card>

            {data.history.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    {t("products.costHistory.title")}
                  </Text>
                  {data.history.map((h, i) => (
                    <InlineStack key={i} align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">
                        {relativeTime(h.at)}
                      </Text>
                      <Text as="span" variant="bodySm">
                        {formatMoney(h.price, data.currency)} · {t("common.stock")} {h.stock}
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
