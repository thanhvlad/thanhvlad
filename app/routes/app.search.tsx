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
  FormLayout,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  List,
  Page,
  Pagination,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { EmptyScreen } from "~/components/EmptyScreen";
import { SectionHeader } from "~/components/SectionHeader";
import { PlatformBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney, formatNumber, pageParam, truncate } from "~/lib/format";
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

type SortKey = "default" | "orders" | "price_asc" | "price_desc" | "newest" | "rating";

export default function SearchPage() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  const [q, setQ] = useState(data.q);
  const [platform, setPlatform] = useState(data.platform);
  const [sort, setSort] = useState<SortKey>(data.sort);
  const [image, setImage] = useState(data.imageUrl);
  const [bulk, setBulk] = useState("");
  const bulkFetcher = useFetcher<typeof action>();
  const t = useT();
  const searching = navigation.state === "loading" && navigation.location?.pathname === "/app/search";

  const platformOptions = data.platforms.map((p) => ({
    label: `${p.displayName}${p.configured ? "" : ` (${t("search.notConfigured")})`}`,
    value: p.platform,
  }));
  const sortOptions: Array<{ label: string; value: SortKey }> = [
    { label: t("search.sort.default"), value: "default" },
    { label: t("search.sort.orders"), value: "orders" },
    { label: t("search.sort.rating"), value: "rating" },
    { label: t("search.sort.priceAsc"), value: "price_asc" },
    { label: t("search.sort.priceDesc"), value: "price_desc" },
    { label: t("search.sort.newest"), value: "newest" },
  ];

  // What the merchant searched for, for the results line: the keyword, or
  // "image" when they searched by picture alone.
  const queryLabel = data.q || t("search.image");
  const hasResults = Boolean(data.results && data.results.items.length > 0);
  const bulkResults = bulkFetcher.data?.bulk;
  const bulkOk = bulkResults ? bulkResults.filter((r) => r.ok).length : 0;

  return (
    <Page
      title={t("page.search.title")}
      subtitle={t("page.search.subtitle")}
      primaryAction={{ content: t("search.page.viewImportList"), url: "/app/import" }}
      secondaryActions={[{ content: t("search.page.extension"), url: "/app/settings/advanced" }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <Form method="get">
              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label={t("search.form.query")}
                    name="q"
                    value={q}
                    onChange={setQ}
                    autoComplete="off"
                    placeholder={t("search.queryPlaceholder")}
                    connectedRight={
                      <Button submit variant="primary" loading={searching}>
                        {t("action.search")}
                      </Button>
                    }
                  />
                  <Select label={t("common.supplier")} name="platform" options={platformOptions} value={platform} onChange={(v) => setPlatform(v as SupplierPlatform)} />
                </FormLayout.Group>
                <FormLayout.Group condensed>
                  <TextField
                    label={t("search.imageUrl.label")}
                    name="image"
                    value={image}
                    onChange={setImage}
                    autoComplete="off"
                    placeholder={t("search.form.imagePlaceholder")}
                  />
                  <Select label={t("search.sort.label")} name="sort" value={sort} onChange={(v) => setSort(v as SortKey)} options={sortOptions} />
                </FormLayout.Group>
              </FormLayout>
            </Form>
          </Card>
        </Layout.Section>

        {(data.error || data.results?.notice) && (
          <Layout.Section>
            <BlockStack gap="300">
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
            </BlockStack>
          </Layout.Section>
        )}

        <Layout.Section>
          {!data.results && !data.error && (
            <EmptyScreen
              heading={t("search.start.heading")}
              body={t("search.start.body")}
              action={{ content: t("search.start.action"), url: "/app/settings/advanced" }}
            />
          )}
          {data.results && !hasResults && (
            <EmptyScreen
              heading={t("search.results.empty.heading", { query: queryLabel })}
              body={t("search.results.empty.body")}
              action={{ content: t("search.results.empty.action"), url: "/app/search" }}
            />
          )}
          {data.results && hasResults && (
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center" gap="200">
                <Text as="p" tone="subdued" numeric>
                  {data.results.total !== null
                    ? t("search.results.count", { count: formatNumber(data.results.total), query: queryLabel })
                    : t("search.results.countUnknown", { query: queryLabel })}
                </Text>
                <Text as="p" tone="subdued" numeric>
                  {t("search.results.page", { page: data.page })}
                </Text>
              </InlineStack>
              <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 4 }} gap="400">
                {data.results.items.map((item) => (
                  <ResultCard key={item.externalId} item={item} platform={data.platform} currency={item.currency} />
                ))}
              </InlineGrid>
              {(data.page > 1 || data.results.hasMore) && (
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={data.page > 1}
                    previousURL={`?${withPage(params, data.page - 1)}`}
                    hasNext={data.results.hasMore}
                    nextURL={`?${withPage(params, data.page + 1)}`}
                    label={t("search.results.page", { page: data.page })}
                  />
                </InlineStack>
              )}
            </BlockStack>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <SectionHeader title={t("search.importByLink.title")} />
              <Text as="p" tone="subdued">
                {t("search.importByLink.help")}
              </Text>
              <TextField
                label={t("search.productLinks.label")}
                labelHidden
                multiline={4}
                value={bulk}
                onChange={setBulk}
                autoComplete="off"
                placeholder={t("search.bulk.placeholder")}
              />
              <InlineStack gap="200">
                <Button
                  onClick={() => bulkFetcher.submit({ intent: "add-bulk", references: bulk, platform }, { method: "post" })}
                  loading={bulkFetcher.state !== "idle"}
                  disabled={!bulk.trim()}
                >
                  {t("action.addToImport")}
                </Button>
              </InlineStack>
              {bulkResults && (
                <Banner
                  tone={bulkOk === bulkResults.length ? "success" : bulkOk === 0 ? "critical" : "warning"}
                  title={t("search.bulk.summary", { ok: bulkOk, total: bulkResults.length })}
                >
                  <List>
                    {bulkResults.map((r) => (
                      <List.Item key={r.reference}>
                        {/* Without the status word a failed row was
                            indistinguishable from an imported one. */}
                        <Text as="span" tone={r.ok ? "success" : "critical"} fontWeight="semibold">
                          {r.ok ? t("search.bulk.added") : t("search.bulk.failed")}
                        </Text>{" "}
                        {r.reference} — {r.ok ? r.title : r.error}
                      </List.Item>
                    ))}
                  </List>
                </Banner>
              )}
            </BlockStack>
          </Card>
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

/**
 * One search hit.
 *
 * The card is built so the merchant can decide from three lines — picture,
 * price, proof (rating and orders) — and act with one full-width button. The
 * "add to shop" shortcut and the supplier link stay, but below the fold of the
 * decision, in the same row.
 */
function ResultCard({ item, platform, currency }: { item: SupplierSearchResult["items"][number]; platform: SupplierPlatform; currency: string }) {
  const fetcher = useFetcher<typeof action>();
  const [pushing, setPushing] = useState(false);
  const t = useT();
  const result = fetcher.data as SearchActionData | undefined;
  const failureMessage = useErrorMessage(result);
  const added = Boolean(result?.ok && result.reference === item.url);
  const failed = Boolean(result && !result.ok && result.reference === item.url);
  const busy = fetcher.state !== "idle";
  const pushedId = added ? result?.productId : undefined;
  const importId = added ? result?.id : undefined;

  const proof: string[] = [];
  if (item.rating) proof.push(`★ ${item.rating.toFixed(1)}`);
  if (item.orderCount) proof.push(t("search.card.orders", { count: formatNumber(item.orderCount) }));

  const shippingParts: string[] = [];
  if (item.shippingFrom !== null && item.shippingFrom !== undefined) {
    shippingParts.push(Number(item.shippingFrom) === 0 ? t("search.freeShipping") : t("search.card.shipping", { amount: formatMoney(item.shippingFrom, currency) }));
  } else {
    shippingParts.push(t("search.shippingAtImport"));
  }
  if (item.shipToDays) shippingParts.push(t("search.card.eta", { days: item.shipToDays }));

  return (
    <Card padding="0">
      <Box background="bg-surface-secondary" minHeight="220px" overflowY="hidden">
        <InlineStack align="center" blockAlign="center">
          {item.image ? (
            // A native img, not Polaris Image: `loading` is not on ImageProps in
            // this version, and a page of 24 full-size supplier photos loading
            // at once inside the admin iframe is worth the one exception.
            <img src={item.image} alt={item.title} loading="lazy" style={{ width: "100%", display: "block" }} />
          ) : (
            <Box paddingBlock="1600">
              <Thumb src={null} alt={t("search.card.noImage")} size="large" />
            </Box>
          )}
        </InlineStack>
      </Box>
      <Box padding="300">
        <BlockStack gap="300">
          <BlockStack gap="100">
            <Text as="h3" variant="bodyMd" fontWeight="semibold" breakWord>
              {truncate(item.title, 72)}
            </Text>
            <InlineStack gap="150" blockAlign="baseline">
              <Text as="span" variant="headingLg" numeric>
                {formatMoney(item.price, currency)}
              </Text>
              {item.originalPrice && (
                <Text as="span" variant="bodySm" tone="subdued" numeric textDecorationLine="line-through">
                  {formatMoney(item.originalPrice, currency)}
                </Text>
              )}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued" numeric>
              {proof.length > 0 ? proof.join(" · ") : t("search.card.noStats")}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued" numeric>
              {shippingParts.join(" · ")}
            </Text>
          </BlockStack>

          <InlineStack gap="200" blockAlign="center">
            <PlatformBadge platform={platform} />
            {item.storeName && (
              <Text as="span" variant="bodySm" tone="subdued">
                {truncate(item.storeName, 28)}
              </Text>
            )}
          </InlineStack>

          <BlockStack gap="200">
            {added && importId ? (
              <Button fullWidth variant="primary" tone="success" icon={CheckIcon} url={`/app/import/${importId}`}>
                {t("search.card.added")}
              </Button>
            ) : (
              <Button
                fullWidth
                variant="primary"
                loading={busy && !pushing}
                disabled={busy && pushing}
                onClick={() => {
                  setPushing(false);
                  fetcher.submit({ intent: "add", reference: item.url, platform }, { method: "post" });
                }}
              >
                {t("action.addToImport")}
              </Button>
            )}
            <InlineStack align="space-between" blockAlign="center" gap="200">
              <Link url={item.url} external target="_blank" removeUnderline>
                {t("search.card.viewSource")}
              </Link>
              {pushedId ? (
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="success">{t("search.inShop")}</Badge>
                  <Link url={`/app/products/${pushedId}`} removeUnderline>
                    {t("search.openInApp")}
                  </Link>
                </InlineStack>
              ) : (
                <Button
                  variant="tertiary"
                  loading={busy && pushing}
                  disabled={busy && !pushing}
                  onClick={() => {
                    setPushing(true);
                    fetcher.submit({ intent: "add-and-push", reference: item.url, platform }, { method: "post" });
                  }}
                >
                  {t("action.addToShop")}
                </Button>
              )}
            </InlineStack>
            {failed && failureMessage && (
              <Text as="p" tone="critical" variant="bodySm">
                {failureMessage}
              </Text>
            )}
          </BlockStack>
        </BlockStack>
      </Box>
    </Card>
  );
}
