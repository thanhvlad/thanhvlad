import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
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
  Page,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney } from "~/lib/format";
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
        return { ok: true, message: "Saved." };
      }
      case "apply-rule":
        await applyPricingRuleToImport(shop.id, id, get("ruleId") || null);
        return { ok: true, message: "Pricing rule applied." };
      case "push": {
        const result = await pushImportedProduct(shop, graphql, id, actor);
        if (result.ok) throw redirect(`/app/products/${result.productId}`);
        return { ok: false, error: result.error };
      }
      case "split": {
        const created = await splitImportedProduct(shop.id, id, get("option"));
        return { ok: true, message: `Split into ${created.length} products.`, redirectTo: "/app/import" };
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

export default function ImportEditPage() {
  const { product, rules, collections, shipping, currency, country } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [tab, setTab] = useState(0);
  const [form, setForm] = useState({ title: product.title, description: product.description, vendor: product.vendor, productType: product.productType, tags: product.tags, handle: product.handle });
  const [collectionsSel, setCollectionsSel] = useState<string[]>(product.collections);
  const [images, setImages] = useState<string[]>(product.images);
  const [newImage, setNewImage] = useState("");
  const [excluded, setExcluded] = useState<Record<string, string[]>>(product.excludedValues);
  const [variants, setVariants] = useState(product.variants);
  const [ruleId, setRuleId] = useState(product.pricingRuleId);
  const [bulkPrice, setBulkPrice] = useState("");

  // In an effect: calling navigate() from the render body updates the router
  // while another component is rendering, and runs twice under StrictMode, so
  // a split pushed two history entries.
  const redirectTo = fetcher.data && "redirectTo" in fetcher.data ? fetcher.data.redirectTo : null;
  useEffect(() => {
    if (redirectTo) navigate(redirectTo);
  }, [redirectTo, navigate]);

  const save = () => {
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

  const updateVariant = (id: string, patch: Partial<(typeof variants)[number]>) => setVariants((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  const optionValues = (index: number) => [...new Set(variants.map((v) => v.optionValues[index]).filter(Boolean))];
  const isExcluded = (v: (typeof variants)[number]) => product.options.some((name, i) => (excluded[name] ?? []).includes(v.optionValues[i]));

  const tabs = [
    { id: "product", content: "Product" },
    { id: "description", content: "Description" },
    { id: "variants", content: `Variants (${variants.filter((v) => v.isEnabled && !isExcluded(v)).length}/${variants.length})` },
    { id: "images", content: `Images (${images.length})` },
    { id: "shipping", content: "Shipping" },
  ];

  return (
    <Page
      backAction={{ url: "/app/import" }}
      title={product.title}
      titleMetadata={<StatusBadge status={product.status} />}
      primaryAction={{ content: "Push to Shopify", onAction: () => fetcher.submit({ intent: "push" }, { method: "post" }), loading: fetcher.state !== "idle", disabled: product.status === "PUSHED" }}
      secondaryActions={[
        { content: "Save", onAction: save },
        { content: "Remove", destructive: true, onAction: () => fetcher.submit({ intent: "remove" }, { method: "post" }) },
      ]}
    >
      <Layout>
        <Layout.Section>
          {fetcher.data && "message" in fetcher.data && fetcher.data.message && (
            <Banner tone="success">
              <p>{fetcher.data.message}</p>
            </Banner>
          )}
          {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
            <Banner tone="critical">
              <p>{fetcher.data.error}</p>
            </Banner>
          )}
          {product.pushError && product.status === "FAILED" && (
            <Banner tone="critical" title="Last push failed">
              <p>{product.pushError}</p>
            </Banner>
          )}
          {product.status === "PUSHED" && product.pushedProductId && (
            <Banner tone="success" title="Already in your store" action={{ content: "Open product", url: `/app/products/${product.pushedProductId}` }} />
          )}
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={tab} onSelect={setTab} />
            <Box padding="400">
              {tab === 0 && (
                <FormLayout>
                  <TextField label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} autoComplete="off" maxLength={255} showCharacterCount />
                  <FormLayout.Group>
                    <TextField label="Vendor" value={form.vendor} onChange={(v) => setForm({ ...form, vendor: v })} autoComplete="off" />
                    <TextField label="Product type" value={form.productType} onChange={(v) => setForm({ ...form, productType: v })} autoComplete="off" />
                  </FormLayout.Group>
                  <TextField label="Tags" value={form.tags} onChange={(v) => setForm({ ...form, tags: v })} autoComplete="off" helpText="Comma separated" />
                  <TextField label="URL handle" value={form.handle} onChange={(v) => setForm({ ...form, handle: v })} autoComplete="off" helpText="Leave blank to generate from the title" />
                  {collections.length > 0 && (
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="semibold">
                        Collections
                      </Text>
                      <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="100">
                        {collections.map((c) => (
                          <Checkbox key={c.id} label={c.title} checked={collectionsSel.includes(c.id)} onChange={(checked) => setCollectionsSel((s) => (checked ? [...s, c.id] : s.filter((x) => x !== c.id)))} />
                        ))}
                      </InlineGrid>
                    </BlockStack>
                  )}
                </FormLayout>
              )}

              {tab === 1 && (
                <BlockStack gap="300">
                  <TextField label="Description (HTML)" value={form.description} onChange={(v) => setForm({ ...form, description: v })} multiline={16} autoComplete="off" />
                  <Text as="p" fontWeight="semibold">
                    Preview
                  </Text>
                  <Box borderColor="border" borderWidth="025" borderRadius="200" padding="300">
                    <div dangerouslySetInnerHTML={{ __html: form.description }} />
                  </Box>
                </BlockStack>
              )}

              {tab === 2 && (
                <BlockStack gap="400">
                  <InlineStack gap="300" blockAlign="end" wrap>
                    <Select label="Pricing rule" options={[{ label: "Built-in default", value: "" }, ...rules.map((r) => ({ label: r.name, value: r.id }))]} value={ruleId} onChange={setRuleId} />
                    <Button onClick={() => fetcher.submit({ intent: "apply-rule", ruleId }, { method: "post" })}>Apply rule to all variants</Button>
                    <TextField label="Set all prices to" value={bulkPrice} onChange={setBulkPrice} type="number" autoComplete="off" prefix={currency} />
                    <Button
                      disabled={!bulkPrice}
                      onClick={() => {
                        setVariants((vs) => vs.map((v) => ({ ...v, price: Number(bulkPrice).toFixed(2) })));
                        setBulkPrice("");
                      }}
                    >
                      Apply
                    </Button>
                  </InlineStack>

                  {product.options.length > 0 && (
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="semibold">
                        Exclude option values
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
                          <Button size="slim" onClick={() => fetcher.submit({ intent: "split", option: name }, { method: "post" })}>
                            Split product by {name}
                          </Button>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  )}

                  <Divider />
                  <BlockStack gap="200">
                    {variants.map((v) => {
                      const off = isExcluded(v);
                      const margin = Number(v.price) > 0 ? (((Number(v.price) - Number(v.cost)) / Number(v.price)) * 100).toFixed(1) : "0.0";
                      return (
                        <Box key={v.id} padding="300" background={off || !v.isEnabled ? "bg-surface-secondary" : undefined} borderRadius="200" borderColor="border" borderWidth="025">
                          <InlineGrid columns={{ xs: 1, md: ["oneThird", "twoThirds"] }} gap="300">
                            <InlineStack gap="300" blockAlign="center">
                              <Checkbox label="" labelHidden checked={v.isEnabled && !off} disabled={off} onChange={(checked) => updateVariant(v.id, { isEnabled: checked })} />
                              {v.image && <img src={v.image} alt="" width={48} height={48} style={{ borderRadius: 8, objectFit: "cover" }} />}
                              <BlockStack gap="050">
                                <Text as="p" fontWeight="semibold">
                                  {v.title}
                                </Text>
                                <InlineStack gap="100">
                                  <Text as="span" tone="subdued" variant="bodySm">
                                    Cost {formatMoney(v.cost, currency)}
                                  </Text>
                                  <Text as="span" tone="subdued" variant="bodySm">
                                    · Margin {margin}%
                                  </Text>
                                  {v.supplierStock !== null && (
                                    <Badge tone={v.supplierAvailable && v.supplierStock > 0 ? "success" : "critical"}>{`Stock ${v.supplierStock}`}</Badge>
                                  )}
                                </InlineStack>
                              </BlockStack>
                            </InlineStack>
                            <InlineGrid columns={{ xs: 2, md: 4 }} gap="200">
                              <TextField label="Price" type="number" value={v.price} onChange={(val) => updateVariant(v.id, { price: val })} autoComplete="off" prefix={currency} />
                              <TextField label="Compare at" type="number" value={v.compareAtPrice} onChange={(val) => updateVariant(v.id, { compareAtPrice: val })} autoComplete="off" prefix={currency} />
                              <TextField label="SKU" value={v.sku} onChange={(val) => updateVariant(v.id, { sku: val })} autoComplete="off" />
                              <TextField label="Inventory" type="number" value={String(v.inventory)} onChange={(val) => updateVariant(v.id, { inventory: Number(val) })} autoComplete="off" />
                            </InlineGrid>
                          </InlineGrid>
                        </Box>
                      );
                    })}
                  </BlockStack>
                </BlockStack>
              )}

              {tab === 3 && (
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <TextField label="Add image URL" value={newImage} onChange={setNewImage} autoComplete="off" />
                    </div>
                    <Button
                      onClick={() => {
                        if (newImage.trim()) setImages((imgs) => [...imgs, newImage.trim()]);
                        setNewImage("");
                      }}
                    >
                      Add
                    </Button>
                  </InlineStack>
                  <InlineGrid columns={{ xs: 2, sm: 3, md: 5 }} gap="200">
                    {images.map((src, i) => (
                      <Box key={`${src}-${i}`} borderColor="border" borderWidth="025" borderRadius="200" padding="100">
                        <BlockStack gap="100">
                          <img src={src} alt="" style={{ width: "100%", aspectRatio: "1/1", objectFit: "cover", borderRadius: 6 }} />
                          <InlineStack gap="100" align="space-between">
                            <Button size="micro" disabled={i === 0} onClick={() => setImages((imgs) => swap(imgs, i, i - 1))}>
                              ←
                            </Button>
                            <Button size="micro" tone="critical" onClick={() => setImages((imgs) => imgs.filter((_, j) => j !== i))}>
                              Remove
                            </Button>
                            <Button size="micro" disabled={i === images.length - 1} onClick={() => setImages((imgs) => swap(imgs, i, i + 1))}>
                              →
                            </Button>
                          </InlineStack>
                        </BlockStack>
                      </Box>
                    ))}
                  </InlineGrid>
                  <Text as="p" tone="subdued" variant="bodySm">
                    The first image is the featured image.
                  </Text>
                </BlockStack>
              )}

              {tab === 4 && (
                <BlockStack gap="300">
                  <Text as="p" tone="subdued">
                    Shipping methods offered by the supplier to {country} for one unit.
                  </Text>
                  {shipping.length === 0 ? (
                    <Text as="p">No shipping quotes available.</Text>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "numeric", "text", "text"]}
                      headings={["Carrier", "Cost", "Delivery", "Tracking"]}
                      rows={shipping.map((s) => [s.carrierName, formatMoney(s.cost, s.currency), s.minDeliveryDays && s.maxDeliveryDays ? `${s.minDeliveryDays}–${s.maxDeliveryDays} days` : "—", s.hasTracking ? "Yes" : "No"])}
                    />
                  )}
                </BlockStack>
              )}
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Supplier
              </Text>
              {product.supplier ? (
                <BlockStack gap="100">
                  <PlatformBadge platform={product.supplier.platform} />
                  {product.supplier.storeName && <Text as="p">{product.supplier.storeName}</Text>}
                  <InlineStack gap="200">
                    {product.supplier.rating ? <Badge>{`★ ${product.supplier.rating.toFixed(1)}`}</Badge> : null}
                    {product.supplier.orderCount ? <Badge>{`${product.supplier.orderCount.toLocaleString()} orders`}</Badge> : null}
                  </InlineStack>
                  {product.supplier.url && (
                    <Button url={product.supplier.url} external size="slim">
                      Open supplier page
                    </Button>
                  )}
                </BlockStack>
              ) : (
                <Text as="p" tone="subdued">
                  Not linked to a supplier product.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function swap<T>(arr: T[], a: number, b: number): T[] {
  const next = [...arr];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}
