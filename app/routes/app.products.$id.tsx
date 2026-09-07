import { useMemo, useState } from "react";
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
import { errorMessage } from "~/lib/errors";
import { adminUrl, formatMoney, legacyId, relativeTime } from "~/lib/format";
import { addSupplierProductForMapping, autoMapByOptions, getMapping, getSupplierProductWithVariants, resolveForVariant, saveMapping, supplierProductsForProduct, type MappingRowInput } from "~/services/mapping.server";
import { listPricingRules } from "~/services/pricing.server";
import { deleteProducts, getProduct, repriceProduct, setAutoUpdate, syncProductFromShopify } from "~/services/products.server";
import { priceHistory } from "~/services/suppliers/catalog.server";

const MAPPING_HELP: Record<MappingType, string> = {
  BASIC: "One supplier SKU per variant. The simplest setup.",
  ADVANCED: "Rank several supplier SKUs per variant, optionally per destination country. The first in-stock option wins.",
  BOGO: "Choose the supplier SKU and quantity by how many units the customer ordered (e.g. buy 2 → ship a 3-pack).",
  BUNDLE: "Fulfil one variant with several supplier SKUs at once (all components must be in stock).",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const product = await getProduct(shop.id, params.id!);
  if (!product) throw new Response("Not found", { status: 404 });
  const [mapping, pool, rules] = await Promise.all([getMapping(product.id), supplierProductsForProduct(product.id), listPricingRules(shop.id)]);

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
        return { ok: true, message: "Mapping saved." };
      }
      case "add-supplier": {
        const sp = await addSupplierProductForMapping(shop.id, get("reference"));
        // Keep the freshly loaded supplier in the URL so the loader includes its SKUs.
        const existing = get("suppliers").split(",").filter(Boolean);
        const suppliers = [...new Set([...existing, sp.id])].join(",");
        throw redirect(`/app/products/${id}?suppliers=${suppliers}&loaded=${encodeURIComponent(sp.title)}`);
      }
      case "auto-map": {
        const rows = await autoMapByOptions(id, get("supplierProductId"));
        return { ok: true, message: `${rows.length} variant(s) matched by option values.`, autoRows: rows };
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
        return { ok: true, message: `${n} variant(s) repriced.` };
      }
      case "toggle-auto": {
        await setAutoUpdate(shop.id, [id], get("enabled") === "true");
        return { ok: true, message: `Auto-update ${get("enabled") === "true" ? "enabled" : "disabled"}.` };
      }
      case "refresh": {
        const product = await getProduct(shop.id, id);
        if (product) await syncProductFromShopify(shop, graphql, product.shopifyProductId);
        return { ok: true, message: "Refreshed from Shopify." };
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
    return { ok: false, error: errorMessage(e) };
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
};

export default function ProductDetailPage() {
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

  const result = fetcher.data as { ok?: boolean; message?: string; error?: string; autoRows?: MappingRowInput[] } | undefined;
  if (result?.autoRows && result.autoRows.length && !rows.some((r) => r.key.startsWith("auto"))) {
    const supplierProductId = data.supplierProducts.find((sp) => sp.variants.some((v) => v.id === result.autoRows![0].supplierVariantId))?.id ?? "";
    setRows(result.autoRows.map((r, i) => ({ key: `auto${i}`, productVariantId: r.productVariantId, supplierProductId, supplierVariantId: r.supplierVariantId, quantity: 1, priority: 0, shipToCountry: "*", minQuantity: null, maxQuantity: null, bundleGroup: null, isDefault: true, isEnabled: true })));
  }

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
      { intent: "save-mapping", type, isEnabled: String(enabled), notes, rows: JSON.stringify(rows.filter((r) => r.supplierVariantId).map(({ key: _k, supplierProductId: _s, ...r }) => r)) },
      { method: "post" },
    );

  const preview = (previewFetcher.data as { preview?: Array<{ variantId: string; title: string; result: ResolveResult }> } | undefined)?.preview;

  return (
    <Page
      backAction={{ url: "/app/products" }}
      title={data.product.title}
      titleMetadata={<StatusBadge status={data.product.status} />}
      primaryAction={{ content: "Save mapping", onAction: save, loading: fetcher.state !== "idle" }}
      secondaryActions={[
        { content: "Open in Shopify", url: adminUrl(data.shopDomain, `/products/${legacyId(data.product.shopifyProductId)}`), external: true },
        { content: "Refresh from Shopify", onAction: () => fetcher.submit({ intent: "refresh" }, { method: "post" }) },
        { content: data.product.autoUpdate ? "Disable auto-update" : "Enable auto-update", onAction: () => fetcher.submit({ intent: "toggle-auto", enabled: String(!data.product.autoUpdate) }, { method: "post" }) },
        { content: "Unlink from app", destructive: true, onAction: () => fetcher.submit({ intent: "delete", alsoInShopify: "false" }, { method: "post" }) },
      ]}
    >
      <Layout>
        <Layout.Section>
          {data.loadedMessage && (
            <Banner tone="success">
              <p>Supplier product “{data.loadedMessage}” loaded. Pick its SKUs below or use auto-map.</p>
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
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Supplier mapping
                </Text>
                <Checkbox label="Mapping enabled" checked={enabled} onChange={setEnabled} />
              </InlineStack>
              <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="300">
                <Select
                  label="Mapping type"
                  value={type}
                  onChange={(v) => setType(v as MappingType)}
                  options={[
                    { label: "Basic", value: "BASIC" },
                    { label: "Advanced (ranked / per country)", value: "ADVANCED" },
                    { label: "BOGO / quantity tiers", value: "BOGO" },
                    { label: "Bundle", value: "BUNDLE" },
                  ]}
                />
                <Box paddingBlockStart="600">
                  <Text as="p" tone="subdued">
                    {MAPPING_HELP[type]}
                  </Text>
                </Box>
              </InlineGrid>

              <Divider />
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Supplier products
                </Text>
                <InlineStack gap="200" blockAlign="end">
                  <div style={{ flex: 1 }}>
                    <TextField label="Add supplier product by URL or ID" value={supplierRef} onChange={setSupplierRef} autoComplete="off" placeholder="https://www.aliexpress.com/item/1005006001.html" />
                  </div>
                  <Button onClick={() => fetcher.submit({ intent: "add-supplier", reference: supplierRef, suppliers: data.loadedSuppliers.join(",") }, { method: "post" })} disabled={!supplierRef.trim()} loading={fetcher.state !== "idle"}>
                    Load
                  </Button>
                </InlineStack>
                {data.supplierProducts.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No supplier product loaded yet. Paste a link above.
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
                              {!sp.isAvailable && <Badge tone="critical">Unavailable</Badge>}
                              <Badge>{`${sp.variants.length} SKUs`}</Badge>
                            </InlineStack>
                            <InlineStack gap="200">
                              <Button size="slim" onClick={() => fetcher.submit({ intent: "auto-map", supplierProductId: sp.id }, { method: "post" })}>
                                Auto-map by options
                              </Button>
                              {sp.url && (
                                <Button size="slim" url={sp.url} external>
                                  Open
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
                            {variant.sku ? `SKU ${variant.sku} · ` : ""}Price {formatMoney(variant.price, data.currency)} · Stock {variant.inventory}
                          </Text>
                        </BlockStack>
                        <Button size="slim" onClick={() => addRow(variant.id)} disabled={data.supplierProducts.length === 0 || (type === "BASIC" && rowsFor(variant.id).length >= 1)}>
                          Add supplier option
                        </Button>
                      </InlineStack>
                      {rowsFor(variant.id).length === 0 && (
                        <Text as="p" tone="critical" variant="bodySm">
                          Not mapped — orders for this variant will be held.
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
                                  label="Supplier product"
                                  value={sp?.id ?? ""}
                                  onChange={(v) => updateRow(row.key, { supplierProductId: v, supplierVariantId: supplierById.get(v)?.variants[0]?.id ?? "" })}
                                  options={data.supplierProducts.map((p) => ({ label: p.title.slice(0, 60), value: p.id }))}
                                />
                                <Select
                                  label="Supplier SKU"
                                  value={row.supplierVariantId}
                                  onChange={(v) => updateRow(row.key, { supplierVariantId: v })}
                                  options={(sp?.variants ?? []).map((v) => ({ label: `${v.label} — ${formatMoney(v.price, v.currency)} (stock ${v.stock})`, value: v.id }))}
                                />
                                <TextField label={type === "BOGO" ? "Units to buy" : "Qty per unit"} type="number" min={1} value={String(row.quantity)} onChange={(v) => updateRow(row.key, { quantity: Math.max(1, Number(v)) })} autoComplete="off" />
                                {type === "ADVANCED" && (
                                  <TextField label="Ship to (ISO code or *)" value={row.shipToCountry} onChange={(v) => updateRow(row.key, { shipToCountry: v.toUpperCase() })} autoComplete="off" />
                                )}
                                {type === "BOGO" && (
                                  <InlineGrid columns={2} gap="100">
                                    <TextField label="Min qty" type="number" value={String(row.minQuantity ?? 1)} onChange={(v) => updateRow(row.key, { minQuantity: Number(v) })} autoComplete="off" />
                                    <TextField label="Max qty" type="number" value={row.maxQuantity === null ? "" : String(row.maxQuantity)} onChange={(v) => updateRow(row.key, { maxQuantity: v === "" ? null : Number(v) })} autoComplete="off" placeholder="∞" />
                                  </InlineGrid>
                                )}
                                {type === "BUNDLE" && <TextField label="Bundle group" value={row.bundleGroup ?? "default"} onChange={(v) => updateRow(row.key, { bundleGroup: v })} autoComplete="off" />}
                              </InlineGrid>
                              <InlineStack gap="300" blockAlign="center" align="space-between">
                                <InlineStack gap="300">
                                  {type !== "BASIC" && <TextField label="Priority" labelHidden type="number" value={String(row.priority)} onChange={(v) => updateRow(row.key, { priority: Number(v) })} autoComplete="off" prefix="Priority" />}
                                  {type === "ADVANCED" && <Checkbox label="Default" checked={row.isDefault} onChange={(c) => updateRow(row.key, { isDefault: c })} />}
                                  <Checkbox label="Enabled" checked={row.isEnabled} onChange={(c) => updateRow(row.key, { isEnabled: c })} />
                                  {sv && <Badge tone={sv.isAvailable && sv.stock > 0 ? "success" : "critical"}>{sv.isAvailable && sv.stock > 0 ? `In stock (${sv.stock})` : "Out of stock"}</Badge>}
                                </InlineStack>
                                <Button size="slim" tone="critical" onClick={() => removeRow(row.key)}>
                                  Remove
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
              <TextField label="Notes" value={notes} onChange={setNotes} autoComplete="off" multiline={2} placeholder="Internal notes about this supplier setup" />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Test the mapping
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  See which supplier SKU an order would use. Save the mapping first.
                </Text>
                <InlineGrid columns={2} gap="200">
                  <TextField label="Ship to" value={previewCountry} onChange={(v) => setPreviewCountry(v.toUpperCase())} autoComplete="off" />
                  <TextField label="Quantity" type="number" value={previewQty} onChange={setPreviewQty} autoComplete="off" />
                </InlineGrid>
                <Button onClick={() => previewFetcher.submit({ intent: "preview", country: previewCountry, quantity: previewQty }, { method: "post" })} loading={previewFetcher.state !== "idle"}>
                  Preview
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
                              ✕ {p.result.failure ? FAILURE_LABELS[p.result.failure] : "Failed"}: {p.result.reason}
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
                  Pricing
                </Text>
                <Select label="Rule" options={[{ label: "Default rule", value: "" }, ...data.rules.map((r) => ({ label: r.name, value: r.id }))]} value={ruleId} onChange={setRuleId} />
                <Button onClick={() => fetcher.submit({ intent: "reprice", ruleId }, { method: "post" })}>Reprice from supplier cost</Button>
                <Text as="p" tone="subdued" variant="bodySm">
                  Auto-update: {data.product.autoUpdate ? "on" : "off"} · Last sync {relativeTime(data.product.lastSyncedAt)}
                </Text>
              </BlockStack>
            </Card>

            {data.history.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Supplier cost history
                  </Text>
                  {data.history.map((h, i) => (
                    <InlineStack key={i} align="space-between">
                      <Text as="span" tone="subdued" variant="bodySm">
                        {relativeTime(h.at)}
                      </Text>
                      <Text as="span" variant="bodySm">
                        {formatMoney(h.price, data.currency)} · stock {h.stock}
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
