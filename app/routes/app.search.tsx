import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useFetcher, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  EmptyState,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { PlatformBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney, pageParam } from "~/lib/format";
import { useErrorMessage, useT } from "~/lib/use-t";
import { addToImportList, pushImportedProduct } from "~/services/import.server";
import { adapterForShop, listPlatforms } from "~/services/suppliers/index.server";
import type { SupplierPlatform, SupplierSearchResult } from "~/services/suppliers/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const platform = (url.searchParams.get("platform") ?? "ALIEXPRESS") as SupplierPlatform;
  const sort = (url.searchParams.get("sort") ?? "default") as "default" | "orders" | "price_asc" | "price_desc" | "newest" | "rating";
  const page = pageParam(url.searchParams.get("page"));
  const imageUrl = url.searchParams.get("image") ?? "";
  const platforms = listPlatforms();

  let results: SupplierSearchResult | null = null;
  let error: string | null = null;
  if (q.trim() || imageUrl.trim()) {
    try {
      const { adapter } = await adapterForShop(shop.id, platform);
      results = await adapter.searchProducts({ query: q, page, pageSize: 24, sort, shipToCountry: shop.country ?? "US", imageUrl: imageUrl || undefined });
    } catch (e) {
      error = errorMessage(e);
    }
  }
  return { q, platform, sort, page, imageUrl, platforms, results, error, currency: shop.currency };
};

interface SearchActionData {
  ok: boolean;
  id?: string;
  title?: string;
  reference?: string;
  error?: string;
  errorKey?: string;
  errorVars?: Record<string, string | number>;
  /** Set when the product went straight to Shopify. */
  productId?: string;
  bulk?: Array<{ reference: string; ok: boolean; title?: string; error?: string }>;
}

export const action = async ({ request }: ActionFunctionArgs): Promise<SearchActionData> => {
  const { shop, actor, graphql } = await requireShop(request);
  const { intent, get, getAll } = await readForm(request);
  const platform = (get("platform") || undefined) as SupplierPlatform | undefined;

  // Import and push in one step, for merchants who do not want to edit first.
  if (intent === "add-and-push") {
    try {
      const product = await addToImportList(shop, get("reference"), { platform, actor });
      const pushed = await pushImportedProduct(shop, graphql, product.id, actor);
      if (!pushed.ok) return { ok: false, error: pushed.error, errorKey: pushed.errorKey, errorVars: pushed.errorVars, reference: get("reference") };
      return { ok: true, id: product.id, productId: pushed.productId, title: product.title, reference: get("reference") };
    } catch (e) {
      return { ok: false, error: errorMessage(e), reference: get("reference") };
    }
  }

  if (intent === "add") {
    try {
      const product = await addToImportList(shop, get("reference"), { platform, actor });
      return { ok: true, id: product.id, title: product.title, reference: get("reference") };
    } catch (e) {
      return { ok: false, error: errorMessage(e), reference: get("reference") };
    }
  }
  if (intent === "add-bulk") {
    const refs = get("references")
      .split(/\r?\n|,/)
      .map((s) => s.trim())
      .filter(Boolean);
    const results: Array<{ reference: string; ok: boolean; title?: string; error?: string }> = [];
    for (const reference of refs.slice(0, 50)) {
      try {
        const product = await addToImportList(shop, reference, { platform, actor });
        results.push({ reference, ok: true, title: product.title });
      } catch (e) {
        results.push({ reference, ok: false, error: errorMessage(e) });
      }
    }
    void getAll;
    return { ok: true, bulk: results };
  }
  return { ok: false, error: "Unknown action" };
};

export default function SearchPage() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const [q, setQ] = useState(data.q);
  const [platform, setPlatform] = useState(data.platform);
  const [sort, setSort] = useState(data.sort);
  const [image, setImage] = useState(data.imageUrl);
  const [bulk, setBulk] = useState("");
  const bulkFetcher = useFetcher<typeof action>();
  const t = useT();
  const searching = navigation.state === "loading" && navigation.location?.pathname === "/app/search";

  const platformOptions = data.platforms.map((p) => ({
    label: `${p.displayName}${p.configured ? "" : ` (${t("search.notConfigured")})`}`,
    value: p.platform,
  }));

  return (
    <Page title={t("page.search.title")} subtitle={t("page.search.subtitle")}>
      <Layout>
        <Layout.Section>
          <Card>
            <Form method="get">
              <BlockStack gap="300">
                <InlineGrid columns={{ xs: 1, md: ["twoThirds", "oneThird"] }} gap="300">
                  <TextField
                    label={t("action.search")}
                    name="q"
                    value={q}
                    onChange={setQ}
                    autoComplete="off"
                    placeholder={t("search.queryPlaceholder")}
                  />
                  <Select label={t("common.supplier")} name="platform" options={platformOptions} value={platform} onChange={(v) => setPlatform(v as SupplierPlatform)} />
                </InlineGrid>
                <InlineGrid columns={{ xs: 1, md: ["twoThirds", "oneThird"] }} gap="300">
                  <TextField label={t("search.imageUrl.label")} name="image" value={image} onChange={setImage} autoComplete="off" placeholder="https://…/photo.jpg" />
                  <Select
                    label={t("search.sort.label")}
                    name="sort"
                    value={sort}
                    onChange={(v) => setSort(v as typeof sort)}
                    options={[
                      { label: t("search.sort.default"), value: "default" },
                      { label: t("search.sort.orders"), value: "orders" },
                      { label: t("search.sort.rating"), value: "rating" },
                      { label: t("search.sort.priceAsc"), value: "price_asc" },
                      { label: t("search.sort.priceDesc"), value: "price_desc" },
                      { label: t("search.sort.newest"), value: "newest" },
                    ]}
                  />
                </InlineGrid>
                <InlineStack gap="200">
                  <Button submit variant="primary" loading={searching}>
                    {t("action.search")}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Form>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("search.importByLink.title")}
              </Text>
              <Text as="p" tone="subdued">
                {t("search.importByLink.help")}
              </Text>
              <TextField label={t("search.productLinks.label")} labelHidden multiline={4} value={bulk} onChange={setBulk} autoComplete="off" placeholder={"https://www.aliexpress.com/item/1005006001.html\n1005006002"} />
              <InlineStack gap="200">
                <Button
                  onClick={() => bulkFetcher.submit({ intent: "add-bulk", references: bulk, platform }, { method: "post" })}
                  loading={bulkFetcher.state !== "idle"}
                  disabled={!bulk.trim()}
                >
                  {t("action.addToImport")}
                </Button>
              </InlineStack>
              {bulkFetcher.data?.bulk && (
                <Banner tone={bulkFetcher.data.bulk.every((r) => r.ok) ? "success" : "warning"}>
                  <BlockStack gap="100">
                    {bulkFetcher.data.bulk.map((r) => (
                      <Text as="p" key={r.reference}>
                        {r.ok ? "✓" : "✕"} {r.reference} {r.ok ? `— ${r.title}` : `— ${r.error}`}
                      </Text>
                    ))}
                  </BlockStack>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          {data.error && (
            <Banner tone="critical" title={t("search.failed")}>
              <p>{data.error}</p>
            </Banner>
          )}
          {data.results?.notice && (
            <Banner tone="warning">
              <p>{data.results.notice}</p>
            </Banner>
          )}
          {!data.results && !data.error && (
            <Card>
              <EmptyState heading={t("search.empty.heading")} image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>{t("search.empty.body")}</p>
              </EmptyState>
            </Card>
          )}
          {data.results && (
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="p" tone="subdued">
                  {`${data.results.total !== null ? data.results.total : data.results.items.length} ${t("search.resultsFor")} “${
                    data.q || t("search.image")
                  }”`}
                </Text>
                <InlineStack gap="200">
                  {data.page > 1 && <Button url={`?${withPage(params, data.page - 1)}`}>{t("common.previous")}</Button>}
                  {data.results.hasMore && <Button url={`?${withPage(params, data.page + 1)}`}>{t("common.next")}</Button>}
                </InlineStack>
              </InlineStack>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 4 }} gap="300">
                {data.results.items.map((item) => (
                  <ResultCard key={item.externalId} item={item} platform={data.platform} currency={item.currency} />
                ))}
              </InlineGrid>
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function withPage(params: URLSearchParams, page: number) {
  const sp = new URLSearchParams(params);
  sp.set("page", String(page));
  return sp.toString();
}

function ResultCard({ item, platform, currency }: { item: SupplierSearchResult["items"][number]; platform: SupplierPlatform; currency: string }) {
  const fetcher = useFetcher<typeof action>();
  const [pushing, setPushing] = useState(false);
  const t = useT();
  const result = fetcher.data as SearchActionData | undefined;
  const failureMessage = useErrorMessage(result);
  const added = result?.ok && result.reference === item.url;
  const failed = result && !result.ok && result.reference === item.url;
  return (
    <Card padding="0">
      <Box>
        <div style={{ aspectRatio: "1 / 1", background: "#f6f6f7", overflow: "hidden" }}>
          {item.image && <img src={item.image} alt={item.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} loading="lazy" />}
        </div>
      </Box>
      <Box padding="300">
        <BlockStack gap="200">
          <Text as="p" variant="bodyMd" fontWeight="semibold" truncate>
            {item.title}
          </Text>
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="headingMd">
              {formatMoney(item.price, currency)}
            </Text>
            {item.originalPrice && (
              <Text as="span" tone="subdued" textDecorationLine="line-through">
                {formatMoney(item.originalPrice, currency)}
              </Text>
            )}
          </InlineStack>
          <InlineStack gap="100" wrap>
            <PlatformBadge platform={platform} />
            {item.rating ? <Badge>{`★ ${item.rating.toFixed(1)}`}</Badge> : null}
            {item.orderCount ? <Badge>{`${item.orderCount.toLocaleString()} ${t("search.orders")}`}</Badge> : null}
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {item.shippingFrom !== null && item.shippingFrom !== undefined
              ? Number(item.shippingFrom) === 0
                ? t("search.freeShipping")
                : `+ ${formatMoney(item.shippingFrom, currency)} ${t("search.shippingSuffix")}`
              : t("search.shippingAtImport")}
            {item.shipToDays ? ` · ~${item.shipToDays} ${t("search.days")}` : ""}
          </Text>
          {item.storeName && (
            <Text as="p" tone="subdued" variant="bodySm" truncate>
              {item.storeName}
            </Text>
          )}
          <Divider />
          <InlineStack gap="100" align="space-between" blockAlign="center" wrap>
            <Button size="slim" url={item.url} target="_blank" external>
              {t("common.view")}
            </Button>
            <InlineStack gap="100">
              <Button
                size="slim"
                disabled={Boolean(added)}
                loading={fetcher.state !== "idle" && !pushing}
                onClick={() => {
                  setPushing(false);
                  fetcher.submit({ intent: "add", reference: item.url, platform }, { method: "post" });
                }}
              >
                {added && !result?.productId ? t("search.inList") : t("action.import")}
              </Button>
              <Button
                size="slim"
                variant="primary"
                disabled={Boolean(result?.productId)}
                loading={fetcher.state !== "idle" && pushing}
                onClick={() => {
                  setPushing(true);
                  fetcher.submit({ intent: "add-and-push", reference: item.url, platform }, { method: "post" });
                }}
              >
                {result?.productId ? t("search.inShop") : t("action.addToShop")}
              </Button>
            </InlineStack>
          </InlineStack>
          {result?.productId && (
            <Button size="micro" variant="plain" url={`/app/products/${result.productId}`}>
              {t("search.openInApp")}
            </Button>
          )}
          {failed && (
            <Text as="p" tone="critical" variant="bodySm">
              {failureMessage}
            </Text>
          )}
        </BlockStack>
      </Box>
    </Card>
  );
}
