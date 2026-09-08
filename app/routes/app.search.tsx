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
import { formatMoney } from "~/lib/format";
import { addToImportList, pushImportedProduct } from "~/services/import.server";
import { adapterForShop, listPlatforms } from "~/services/suppliers/index.server";
import type { SupplierPlatform, SupplierSearchResult } from "~/services/suppliers/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  const platform = (url.searchParams.get("platform") ?? "ALIEXPRESS") as SupplierPlatform;
  const sort = (url.searchParams.get("sort") ?? "default") as "default" | "orders" | "price_asc" | "price_desc" | "newest" | "rating";
  const page = Number(url.searchParams.get("page") ?? 1);
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
      if (!pushed.ok) return { ok: false, error: pushed.error, reference: get("reference") };
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
  const searching = navigation.state === "loading" && navigation.location?.pathname === "/app/search";

  const platformOptions = data.platforms.map((p) => ({ label: `${p.displayName}${p.configured ? "" : " (not configured)"}`, value: p.platform }));

  return (
    <Page title="Find products" subtitle="Search supplier catalogs or paste product links to import.">
      <Layout>
        <Layout.Section>
          <Card>
            <Form method="get">
              <BlockStack gap="300">
                <InlineGrid columns={{ xs: 1, md: ["twoThirds", "oneThird"] }} gap="300">
                  <TextField label="Search" name="q" value={q} onChange={setQ} autoComplete="off" placeholder="e.g. wireless earbuds, yoga mat, phone case" />
                  <Select label="Supplier" name="platform" options={platformOptions} value={platform} onChange={(v) => setPlatform(v as SupplierPlatform)} />
                </InlineGrid>
                <InlineGrid columns={{ xs: 1, md: ["twoThirds", "oneThird"] }} gap="300">
                  <TextField label="Search by image URL (optional)" name="image" value={image} onChange={setImage} autoComplete="off" placeholder="https://…/photo.jpg" />
                  <Select
                    label="Sort"
                    name="sort"
                    value={sort}
                    onChange={(v) => setSort(v as typeof sort)}
                    options={[
                      { label: "Best match", value: "default" },
                      { label: "Most orders", value: "orders" },
                      { label: "Highest rating", value: "rating" },
                      { label: "Price: low to high", value: "price_asc" },
                      { label: "Price: high to low", value: "price_desc" },
                      { label: "Newest", value: "newest" },
                    ]}
                  />
                </InlineGrid>
                <InlineStack gap="200">
                  <Button submit variant="primary" loading={searching}>
                    Search
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
                Import by link or ID
              </Text>
              <Text as="p" tone="subdued">
                Paste one or many AliExpress / CJ product URLs or IDs (one per line). They will land on the import list with your default pricing rule applied.
              </Text>
              <TextField label="Product links" labelHidden multiline={4} value={bulk} onChange={setBulk} autoComplete="off" placeholder={"https://www.aliexpress.com/item/1005006001.html\n1005006002"} />
              <InlineStack gap="200">
                <Button
                  onClick={() => bulkFetcher.submit({ intent: "add-bulk", references: bulk, platform }, { method: "post" })}
                  loading={bulkFetcher.state !== "idle"}
                  disabled={!bulk.trim()}
                >
                  Add to import list
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
            <Banner tone="critical" title="Search failed">
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
              <EmptyState heading="Search a supplier catalog" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>Type a keyword above, or paste product links to import directly.</p>
              </EmptyState>
            </Card>
          )}
          {data.results && (
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="p" tone="subdued">
                  {data.results.total !== null ? `${data.results.total} results` : `${data.results.items.length} results`} for “{data.q || "image"}”
                </Text>
                <InlineStack gap="200">
                  {data.page > 1 && <Button url={`?${withPage(params, data.page - 1)}`}>Previous</Button>}
                  {data.results.hasMore && <Button url={`?${withPage(params, data.page + 1)}`}>Next</Button>}
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
  const result = fetcher.data as SearchActionData | undefined;
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
            {item.orderCount ? <Badge>{`${item.orderCount.toLocaleString()} orders`}</Badge> : null}
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {item.shippingFrom !== null && item.shippingFrom !== undefined
              ? Number(item.shippingFrom) === 0
                ? "Free shipping"
                : `+ ${formatMoney(item.shippingFrom, currency)} shipping`
              : "Shipping shown at import"}
            {item.shipToDays ? ` · ~${item.shipToDays} days` : ""}
          </Text>
          {item.storeName && (
            <Text as="p" tone="subdued" variant="bodySm" truncate>
              {item.storeName}
            </Text>
          )}
          <Divider />
          <InlineStack gap="100" align="space-between" blockAlign="center" wrap>
            <Button size="slim" url={item.url} target="_blank" external>
              View
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
                {added && !result?.productId ? "In list" : "Import"}
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
                {result?.productId ? "In shop" : "Add to shop"}
              </Button>
            </InlineStack>
          </InlineStack>
          {result?.productId && (
            <Button size="micro" variant="plain" url={`/app/products/${result.productId}`}>
              Open in the app
            </Button>
          )}
          {failed && (
            <Text as="p" tone="critical" variant="bodySm">
              {result?.error}
            </Text>
          )}
        </BlockStack>
      </Box>
    </Card>
  );
}
