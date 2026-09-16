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
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  Modal,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { SectionHeader } from "~/components/SectionHeader";
import { Stat } from "~/components/Stat";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import type { MappingType } from "@prisma/client";
import type { ResolveResult } from "~/domain/mapping/types";
import { readForm, requireShop } from "~/lib/auth.server";
import { actionFailure } from "~/lib/errors";
import { adminUrl, formatMoney, legacyId, relativeTime } from "~/lib/format";
import type { I18nKey } from "~/lib/i18n";
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

/**
 * Which confirmation is open. Each of these rewrites something the merchant
 * cannot simply undo - prices in Shopify, the whole mapping, the link to the
 * app - so each one says what it will change before it runs.
 */
type Confirm =
  | { kind: "unlink" }
  | { kind: "reprice" }
  | { kind: "switch"; supplierProductId: string; supplierTitle: string }
  | null;

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
  const [confirm, setConfirm] = useState<Confirm>(null);

  const result = fetcher.data as { ok?: boolean; message?: string; error?: string; aiUsed?: boolean; aiError?: string | null; autoRows?: MappingSuggestionRow[] } | undefined;

  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(result as Parameters<typeof useErrorMessage>[0]);

  // One fetcher serves every button on the page; knowing which intent is in
  // flight is what lets only the pressed button spin instead of all of them.
  const busyIntent = fetcher.state !== "idle" ? String(fetcher.formData?.get("intent") ?? "") : null;
  const busySupplier = fetcher.state !== "idle" ? String(fetcher.formData?.get("supplierProductId") ?? "") : null;

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
  const supplierFor = (row: Pick<Row, "supplierProductId" | "supplierVariantId">) => supplierById.get(row.supplierProductId) ?? data.supplierProducts.find((p) => p.variants.some((v) => v.id === row.supplierVariantId));
  const supplierVariantFor = (row: Pick<Row, "supplierProductId" | "supplierVariantId">) => supplierFor(row)?.variants.find((v) => v.id === row.supplierVariantId);
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

  // Figures for the side column.
  const variants = data.product.variants;
  const mappedCount = variants.filter((v) => rowsFor(v.id).some((r) => r.supplierVariantId)).length;
  const prices = variants.map((v) => Number(v.price));
  const costs = variants.map((v) => (v.cost === null ? NaN : Number(v.cost))).filter((n) => Number.isFinite(n) && n > 0);
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;
  const minCost = costs.length ? Math.min(...costs) : null;
  const maxCost = costs.length ? Math.max(...costs) : null;
  const marginPercent = minCost !== null && minPrice > 0 ? ((minPrice - minCost) / minPrice) * 100 : null;
  const moneyRange = (min: number, max: number) => (min !== max ? `${formatMoney(min, data.currency)} – ${formatMoney(max, data.currency)}` : formatMoney(min, data.currency));

  // The supplier products the saved mapping actually points at.
  const currentSuppliers = [...new Set(data.mapping.rows.map((r) => r.supplierProductId))].map((id) => supplierById.get(id)).filter((sp): sp is NonNullable<typeof sp> => Boolean(sp));

  // Lowest supplier stock among a variant's enabled options, as edited.
  const supplierStockFor = (variantId: string) => {
    const stocks = rowsFor(variantId)
      .filter((r) => r.isEnabled)
      .map((r) => supplierVariantFor(r)?.stock)
      .filter((n): n is number => typeof n === "number");
    return stocks.length ? Math.min(...stocks) : null;
  };

  const comparisonRows = data.comparison.rows.filter((r) => !r.dismissed);
  const betterOption = data.comparison.betterOptionId ? data.comparison.rows.find((r) => r.supplierProductId === data.comparison.betterOptionId) : undefined;
  const compareButton = { content: data.comparison.rows.length ? t("products.compare.recheck") : t("action.compareSuppliers"), onAction: () => fetcher.submit({ intent: "compare-suppliers" }, { method: "post" }) };

  // One modal serves all three confirmations; the copy names the actual
  // consequence rather than asking a bare "are you sure".
  const confirmCopy =
    confirm?.kind === "reprice"
      ? { title: t("products.detail.reprice.title"), body: t("products.detail.reprice.body"), action: t("products.action.repriceFromCost"), destructive: false, loading: busyIntent === "reprice" }
      : confirm?.kind === "switch"
        ? { title: t("products.detail.switch.title"), body: t("products.detail.switch.body", { supplier: confirm.supplierTitle }), action: t("action.switchSupplier"), destructive: false, loading: busyIntent === "switch-supplier" }
        : { title: t("products.detail.unlink.title"), body: t("products.detail.unlink.body"), action: t("products.action.unlinkFromApp"), destructive: true, loading: busyIntent === "delete" };

  const runConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === "unlink") fetcher.submit({ intent: "delete", alsoInShopify: "false" }, { method: "post" });
    if (confirm.kind === "reprice") fetcher.submit({ intent: "reprice", ruleId }, { method: "post" });
    if (confirm.kind === "switch") fetcher.submit({ intent: "switch-supplier", supplierProductId: confirm.supplierProductId }, { method: "post" });
    setConfirm(null);
  };

  return (
    <Page
      backAction={{ url: "/app/products" }}
      title={data.product.title}
      titleMetadata={<StatusBadge status={data.product.status} />}
      subtitle={t("products.detail.subtitle")}
      primaryAction={{ content: t("products.action.saveMapping"), onAction: save, loading: busyIntent === "save-mapping" }}
      secondaryActions={[
        { content: t("products.action.openInShopify"), url: adminUrl(data.shopDomain, `/products/${legacyId(data.product.shopifyProductId)}`), external: true },
        { content: t("products.action.refreshFromShopify"), loading: busyIntent === "refresh", onAction: () => fetcher.submit({ intent: "refresh" }, { method: "post" }) },
        { content: data.product.autoUpdate ? t("products.action.disableAutoUpdate") : t("products.action.enableAutoUpdate"), loading: busyIntent === "toggle-auto", onAction: () => fetcher.submit({ intent: "toggle-auto", enabled: String(!data.product.autoUpdate) }, { method: "post" }) },
        { content: t("products.action.unlinkFromApp"), destructive: true, onAction: () => setConfirm({ kind: "unlink" }) },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
            {data.loadedMessage && (
              <Banner tone="success">
                <p>
                  “{data.loadedMessage}” — {t("products.supplierLoaded")}
                </p>
              </Banner>
            )}
            {actionMessage && result?.ok && (
              <Banner tone={result.aiError ? "warning" : "success"}>
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
          </BlockStack>
        </Layout.Section>

        {/* ---- Main column ------------------------------------------------ */}
        <Layout.Section>
          <BlockStack gap="400">
            {/* Supplier mapping: the thing this screen is for. */}
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
                  <InlineStack gap="200" blockAlign="center">
                    <SectionHeader title={t("products.mapping.title")} />
                    <Badge tone={mappedCount === variants.length && variants.length > 0 ? "success" : "attention"}>{t("products.detail.mapping.coverage", { mapped: mappedCount, total: variants.length })}</Badge>
                  </InlineStack>
                  <Checkbox label={t("products.mapping.enabled")} checked={enabled} onChange={setEnabled} />
                </InlineStack>
                <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="300" alignItems="end">
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
                  <Text as="p" tone="subdued">
                    {t(MAPPING_HELP[type])}
                  </Text>
                </InlineGrid>

                <Divider />

                {/* Supplier products: where the SKUs on the right-hand side come from. */}
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      {t("products.supplierProducts")}
                    </Text>
                    <Badge>{String(data.supplierProducts.length)}</Badge>
                  </InlineStack>
                  <TextField
                    label={t("products.addSupplier.label")}
                    value={supplierRef}
                    onChange={setSupplierRef}
                    autoComplete="off"
                    placeholder="https://www.aliexpress.com/item/1005006001.html"
                    connectedRight={
                      <Button onClick={() => fetcher.submit({ intent: "add-supplier", reference: supplierRef, suppliers: data.loadedSuppliers.join(",") }, { method: "post" })} disabled={!supplierRef.trim()} loading={busyIntent === "add-supplier"}>
                        {t("products.action.load")}
                      </Button>
                    }
                  />
                  {data.supplierProducts.length === 0 ? (
                    <EmptyScreen compact heading={t("products.detail.supplierProducts.empty.heading")} body={t("products.detail.supplierProducts.empty.body")} />
                  ) : (
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="200">
                      {data.supplierProducts.map((sp) => (
                        <Box key={sp.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                          <InlineStack gap="300" blockAlign="start" wrap={false}>
                            <Thumb src={sp.image} alt={sp.title} />
                            <BlockStack gap="150">
                              <Text as="p" fontWeight="semibold">
                                {sp.title}
                              </Text>
                              <InlineStack gap="100" wrap>
                                <PlatformBadge platform={sp.platform} />
                                {!sp.isAvailable && <Badge tone="critical">{t("common.unavailable")}</Badge>}
                                <Badge>{t("products.detail.skus", { n: sp.variants.length })}</Badge>
                              </InlineStack>
                              <InlineStack gap="200" wrap>
                                <Button size="slim" loading={busyIntent === "auto-map" && busySupplier === sp.id && fetcher.formData?.get("useAi") !== "true"} onClick={() => fetcher.submit({ intent: "auto-map", supplierProductId: sp.id, useAi: "false" }, { method: "post" })}>
                                  {t("action.autoMap")}
                                </Button>
                                <Button
                                  size="slim"
                                  variant="primary"
                                  disabled={!data.aiAvailable}
                                  loading={busyIntent === "auto-map" && busySupplier === sp.id && fetcher.formData?.get("useAi") === "true"}
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

                {/* The variant table: one block per Shopify variant, its supplier options beneath. */}
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      {t("common.variants")}
                    </Text>
                    <Badge>{String(variants.length)}</Badge>
                  </InlineStack>
                  {variants.map((variant) => {
                    const variantRows = rowsFor(variant.id);
                    return (
                      <Box key={variant.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                        <BlockStack gap="200">
                          <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
                            <InlineStack gap="300" blockAlign="center" wrap>
                              <BlockStack gap="050">
                                <Text as="p" fontWeight="semibold">
                                  {variant.title}
                                </Text>
                                <Text as="span" tone="subdued" variant="bodySm">
                                  {variant.sku ? `SKU ${variant.sku} · ` : ""}
                                  {t("common.price")} {formatMoney(variant.price, data.currency)} · {t("common.stock")} {variant.inventory}
                                </Text>
                              </BlockStack>
                              {variantRows.length === 0 ? <StatusBadge status="FAILED" label={t("common.notMapped")} /> : <StatusBadge status="ENABLED" label={t("products.detail.variant.options", { n: variantRows.length })} />}
                            </InlineStack>
                            <Button size="slim" onClick={() => addRow(variant.id)} disabled={data.supplierProducts.length === 0 || (type === "BASIC" && variantRows.length >= 1)}>
                              {t("products.action.addSupplierOption")}
                            </Button>
                          </InlineStack>
                          {variantRows.length === 0 && (
                            <Text as="p" tone="critical" variant="bodySm">
                              {t("products.variantNotMapped")}
                            </Text>
                          )}
                          {variantRows.map((row) => {
                            const sp = supplierFor(row);
                            const sv = supplierVariantFor(row);
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
                                  <InlineStack gap="300" blockAlign="center" align="space-between" wrap>
                                    <InlineStack gap="300" blockAlign="center" wrap>
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
                    );
                  })}
                </BlockStack>
                <TextField label={t("products.notes.label")} value={notes} onChange={setNotes} autoComplete="off" multiline={2} placeholder={t("products.notes.placeholder")} />
              </BlockStack>
            </Card>

            {/* Supplier comparison: the same item, priced delivered, side by side. */}
            <Card padding="0">
              <Box padding="400">
                <BlockStack gap="300">
                  <SectionHeader title={t("products.compare.title")} count={comparisonRows.length} />
                  <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
                    <Text as="p" tone="subdued" variant="bodySm">
                      {t("products.compare.landedCostNote")} {data.comparison.shipToCountry} ({data.currency}).
                      {data.comparison.evaluatedAt ? ` ${t("products.compare.lastChecked")} ${relativeTime(data.comparison.evaluatedAt)}.` : ""}
                    </Text>
                    <Button onClick={compareButton.onAction} loading={busyIntent === "compare-suppliers"}>
                      {compareButton.content}
                    </Button>
                  </InlineStack>
                  {betterOption && (
                    <Banner tone="success" title={t("products.compare.betterAvailable")}>
                      <p>
                        {`${betterOption.title.slice(0, 70)} — ${t("products.compare.saves")} ${formatMoney(betterOption.savingsVsCurrent ?? 0, data.currency)} ${t("products.compare.perUnit")} (${betterOption.savingsPercent}%), ${t("products.compare.covers")} ${betterOption.matchedVariants}/${betterOption.totalVariants} ${t("products.variantCount")}.`}
                      </p>
                    </Banner>
                  )}
                </BlockStack>
              </Box>
              {comparisonRows.length === 0 ? (
                <Box paddingInline="400" paddingBlockEnd="400">
                  <EmptyScreen compact heading={t("products.detail.compare.empty.heading")} body={t("products.compare.emptyBody")} action={data.comparison.rows.length ? undefined : compareButton} />
                </Box>
              ) : (
                <IndexTable
                  selectable={false}
                  resourceName={{ singular: t("products.detail.compare.resource.singular"), plural: t("products.detail.compare.resource.plural") }}
                  itemCount={comparisonRows.length}
                  headings={[
                    { title: t("products.detail.compare.column.supplier") },
                    { title: t("products.detail.compare.column.coverage"), alignment: "end" },
                    { title: t("products.detail.compare.column.itemShipping"), alignment: "end" },
                    { title: t("products.detail.compare.column.delivery") },
                    { title: t("products.detail.compare.column.landed"), alignment: "end" },
                    { title: t("products.detail.compare.column.saving"), alignment: "end" },
                    { title: t("products.detail.compare.column.actions") },
                  ]}
                >
                  {comparisonRows.map((row, index) => {
                    const saving = row.savingsVsCurrent === null || row.savingsVsCurrent === undefined ? null : Number(row.savingsVsCurrent);
                    return (
                      <IndexTable.Row id={row.supplierProductId} key={row.supplierProductId} position={index} tone={row.isBest && !row.isCurrent ? "success" : undefined}>
                        <IndexTable.Cell>
                          <InlineStack gap="300" blockAlign="center" wrap={false}>
                            <Thumb src={row.image} alt={row.title} />
                            <BlockStack gap="050">
                              <Text as="span" fontWeight="semibold">
                                {row.title.slice(0, 90)}
                              </Text>
                              <InlineStack gap="100" blockAlign="center" wrap>
                                <PlatformBadge platform={row.platform} />
                                {row.isCurrent && <Badge tone="info">{t("products.compare.current")}</Badge>}
                                {row.isBest && !row.isCurrent && <Badge tone="success">{t("products.compare.bestScore")}</Badge>}
                                {!row.isAvailable && <Badge tone="critical">{t("common.outOfStock")}</Badge>}
                                <Badge>{`${t("products.compare.score")} ${row.score}`}</Badge>
                              </InlineStack>
                              <Text as="span" tone="subdued" variant="bodySm">
                                {row.storeName ? `${row.storeName} · ` : ""}
                                {row.rating ? `★ ${row.rating.toFixed(1)} · ` : ""}
                                {row.orderCount ? `${row.orderCount.toLocaleString()} ${t("products.compare.orders")}` : ""}
                              </Text>
                            </BlockStack>
                          </InlineStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" numeric alignment="end" tone={row.matchedVariants < row.totalVariants ? "caution" : undefined}>
                            {`${row.matchedVariants}/${row.totalVariants}`}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" numeric alignment="end">
                            {`${formatMoney(row.itemCost, data.currency)} + ${formatMoney(row.shippingCost, data.currency)}`}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodySm">
                            {row.carrierName ?? ""}
                            {row.deliveryDays ? `${row.carrierName ? " · " : ""}${row.deliveryDays} ${t("products.compare.days")}` : ""}
                            {!row.carrierName && !row.deliveryDays ? "—" : ""}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" numeric alignment="end" fontWeight="semibold">
                            {formatMoney(row.landedCost, data.currency)}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {saving !== null && saving > 0 ? (
                            <Text as="span" numeric alignment="end" tone="success">
                              {`−${formatMoney(saving, data.currency)} (${row.savingsPercent}%)`}
                            </Text>
                          ) : saving !== null && saving < 0 ? (
                            <Text as="span" numeric alignment="end" tone="subdued">
                              {`+${formatMoney(Math.abs(saving), data.currency)} ${t("products.compare.dearer")}`}
                            </Text>
                          ) : (
                            <Text as="span" numeric alignment="end" tone="subdued">
                              —
                            </Text>
                          )}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <InlineStack gap="100" wrap={false}>
                            {!row.isCurrent && (
                              <>
                                <Button
                                  size="slim"
                                  variant="primary"
                                  disabled={!row.isAvailable || row.matchedVariants === 0}
                                  loading={busyIntent === "switch-supplier" && busySupplier === row.supplierProductId}
                                  onClick={() => setConfirm({ kind: "switch", supplierProductId: row.supplierProductId, supplierTitle: row.title.slice(0, 70) })}
                                >
                                  {t("action.switchSupplier")}
                                </Button>
                                <Button size="slim" loading={busyIntent === "dismiss-candidate" && busySupplier === row.supplierProductId} onClick={() => fetcher.submit({ intent: "dismiss-candidate", supplierProductId: row.supplierProductId }, { method: "post" })}>
                                  {t("products.compare.hide")}
                                </Button>
                              </>
                            )}
                            {row.url && (
                              <Button size="slim" url={row.url} external>
                                {t("common.view")}
                              </Button>
                            )}
                          </InlineStack>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    );
                  })}
                </IndexTable>
              )}
            </Card>

            {/* Inventory and cost per variant, as Shopify and the supplier see it. */}
            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <SectionHeader title={t("products.detail.inventory.title")} count={variants.length} />
              </Box>
              <IndexTable
                selectable={false}
                resourceName={{ singular: t("products.detail.inventory.resource.singular"), plural: t("products.detail.inventory.resource.plural") }}
                itemCount={variants.length}
                headings={[
                  { title: t("products.detail.inventory.column.variant") },
                  { title: t("products.detail.inventory.column.sku") },
                  { title: t("common.price"), alignment: "end" },
                  { title: t("common.cost"), alignment: "end" },
                  { title: t("products.detail.inventory.column.margin"), alignment: "end" },
                  { title: t("common.stock"), alignment: "end" },
                  { title: t("products.detail.inventory.column.supplierStock"), alignment: "end" },
                ]}
              >
                {variants.map((variant, index) => {
                  const price = Number(variant.price);
                  const cost = variant.cost === null ? null : Number(variant.cost);
                  const margin = cost !== null && cost > 0 && price > 0 ? ((price - cost) / price) * 100 : null;
                  const supplierStock = supplierStockFor(variant.id);
                  return (
                    <IndexTable.Row id={variant.id} key={variant.id} position={index}>
                      <IndexTable.Cell>
                        <Text as="span" fontWeight="semibold">
                          {variant.title}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" tone="subdued">
                          {variant.sku || "—"}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end">
                          {formatMoney(variant.price, data.currency)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end" tone={cost === null ? "subdued" : undefined}>
                          {cost === null ? "—" : formatMoney(cost, data.currency)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end" tone={margin === null ? "subdued" : margin < 0 ? "critical" : "success"}>
                          {margin === null ? "—" : `${margin.toFixed(1)}%`}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end" tone={variant.inventory <= 0 ? "critical" : undefined}>
                          {String(variant.inventory)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end" tone={supplierStock === null ? "subdued" : supplierStock <= 0 ? "critical" : undefined}>
                          {supplierStock === null ? "—" : String(supplierStock)}
                        </Text>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* ---- Side column ------------------------------------------------ */}
        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            {/* Product: what Shopify knows about it, and how fresh that is. */}
            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("products.detail.product.title")} />
                <InlineStack gap="300" blockAlign="center" wrap={false}>
                  <Thumb src={data.product.image} alt={data.product.title} size="medium" />
                  <BlockStack gap="100">
                    <Text as="p" fontWeight="semibold">
                      {data.product.title}
                    </Text>
                    <InlineStack gap="100" wrap>
                      <StatusBadge status={data.product.status} />
                      <Badge>{t("products.detail.product.variants", { n: variants.length })}</Badge>
                    </InlineStack>
                    <Link url={adminUrl(data.shopDomain, `/products/${legacyId(data.product.shopifyProductId)}`)} target="_blank">
                      {t("products.action.openInShopify")}
                    </Link>
                  </BlockStack>
                </InlineStack>
                <Divider />
                {/* Status only: the switches themselves live once, in the page
                    header, so the merchant never wonders which copy is real. */}
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  <Text as="span" tone="subdued">
                    {t("products.detail.product.autoUpdate")}
                  </Text>
                  <StatusBadge status={data.product.autoUpdate ? "ENABLED" : "DISABLED"} />
                </InlineStack>
                <InlineStack align="space-between" blockAlign="center" gap="200">
                  <Text as="span" tone="subdued">
                    {t("products.lastSync")}
                  </Text>
                  <Text as="span">{relativeTime(data.product.lastSyncedAt)}</Text>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("products.detail.product.actionsHint")}
                </Text>
              </BlockStack>
            </Card>

            {/* Current supplier: who fulfils this product today. */}
            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("products.detail.supplier.title")} count={currentSuppliers.length || undefined} />
                {currentSuppliers.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {t("products.detail.supplier.none")}
                  </Text>
                ) : (
                  currentSuppliers.map((sp) => (
                    <InlineStack key={sp.id} gap="300" blockAlign="start" wrap={false}>
                      <Thumb src={sp.image} alt={sp.title} />
                      <BlockStack gap="100">
                        <Text as="p" fontWeight="semibold">
                          {sp.title.slice(0, 80)}
                        </Text>
                        <InlineStack gap="100" wrap>
                          <PlatformBadge platform={sp.platform} />
                          {!sp.isAvailable && <Badge tone="critical">{t("common.unavailable")}</Badge>}
                        </InlineStack>
                        {sp.storeName && (
                          <Text as="p" tone="subdued" variant="bodySm">
                            {sp.storeName}
                          </Text>
                        )}
                        {sp.url && (
                          <Link url={sp.url} target="_blank">
                            {t("common.viewOnSupplier")}
                          </Link>
                        )}
                      </BlockStack>
                    </InlineStack>
                  ))
                )}
              </BlockStack>
            </Card>

            {/* Cost summary and the pricing rule that keeps price in step with it. */}
            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("products.detail.cost.title")} />
                <InlineGrid columns={{ xs: 2 }} gap="300">
                  <Stat plain size="medium" label={t("products.detail.cost.supplierCost")} value={minCost === null || maxCost === null ? "—" : moneyRange(minCost, maxCost)} hint={minCost === null ? t("products.detail.cost.noCost") : undefined} tone={minCost === null ? "subdued" : "default"} />
                  <Stat plain size="medium" label={t("products.detail.cost.salePrice")} value={moneyRange(minPrice, maxPrice)} hint={t("products.detail.cost.perVariant", { n: variants.length })} />
                </InlineGrid>
                <Stat plain size="medium" label={t("products.detail.cost.margin")} value={marginPercent === null ? "—" : `${marginPercent.toFixed(1)}%`} hint={marginPercent === null ? undefined : t("products.detail.cost.marginHint")} tone={marginPercent === null ? "subdued" : marginPercent < 0 ? "critical" : "success"} />
                <Divider />
                <Text as="h3" variant="headingSm">
                  {t("products.pricing.title")}
                </Text>
                <Select label={t("products.pricing.rule")} options={[{ label: t("products.pricing.defaultRule"), value: "" }, ...data.rules.map((r) => ({ label: r.name, value: r.id }))]} value={ruleId} onChange={setRuleId} />
                <Button loading={busyIntent === "reprice"} onClick={() => setConfirm({ kind: "reprice" })}>
                  {t("products.action.repriceFromCost")}
                </Button>
              </BlockStack>
            </Card>

            {/* Test the mapping: which supplier SKU an order would resolve to. */}
            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("products.test.title")} />
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
                              ✕ {p.result.failure ? t(`products.detail.failure.${p.result.failure}` as I18nKey) : t("stage.FAILED")}: {p.result.reason}
                            </Text>
                          )}
                        </BlockStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            {/* Supplier cost history for the first mapped SKU. */}
            {data.history.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <SectionHeader title={t("products.costHistory.title")} count={data.history.length} />
                  <InlineStack align="space-between">
                    <Text as="span" tone="subdued" variant="bodySm">
                      {t("products.detail.history.column.when")}
                    </Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {t("common.cost")} · {t("common.stock")}
                    </Text>
                  </InlineStack>
                  {data.history.map((h, i) => (
                    <InlineStack key={i} align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">
                        {relativeTime(h.at)}
                      </Text>
                      <Text as="span" variant="bodySm" numeric>
                        {formatMoney(h.price, data.currency)} · {h.stock}
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirmCopy.title}
        primaryAction={{
          content: confirmCopy.action,
          destructive: confirmCopy.destructive,
          loading: confirmCopy.loading,
          onAction: runConfirm,
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setConfirm(null) }]}
      >
        <Modal.Section>
          <Text as="p">{confirmCopy.body}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
