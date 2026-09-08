import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Badge, Banner, Button, Card, EmptyState, IndexTable, InlineStack, Layout, Page, Select, Text, TextField, useIndexResourceState, BlockStack } from "@shopify/polaris";
import { Paginator } from "~/components/Paginator";
import { StatusBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import prisma from "~/db.server";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney, pageParam, relativeTime } from "~/lib/format";
import { createJobRun } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { listPricingRules } from "~/services/pricing.server";
import { countProducts, deleteProducts, importExistingShopifyProduct, listProducts, repriceProduct, setAutoUpdate, syncProductFromShopify } from "~/services/products.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("q") ?? "";
  const mapped = (url.searchParams.get("mapped") ?? "all") as "all" | "mapped" | "unmapped";
  const page = pageParam(url.searchParams.get("page"));
  const [list, counts, rules] = await Promise.all([listProducts(shop.id, { search, mapped, page }), countProducts(shop.id), listPricingRules(shop.id)]);
  return {
    currency: shop.currency,
    search,
    mapped,
    counts,
    rules: rules.map((r) => ({ id: r.id, name: r.name })),
    list: {
      ...list,
      items: list.items.map((p) => {
        const prices = p.variants.map((v) => Number(v.price));
        const costs = p.variants.map((v) => Number(v.cost ?? 0));
        const stock = p.variants.reduce((n, v) => n + v.inventoryQuantity, 0);
        return {
          id: p.id,
          title: p.title,
          image: p.featuredImage,
          status: p.status,
          variants: p.variants.length,
          mappedRows: p.mapping?._count.variants ?? 0,
          mappingType: p.mapping?.type ?? null,
          mappingEnabled: p.mapping?.isEnabled ?? false,
          autoUpdate: p.autoUpdateEnabled,
          lastSyncedAt: p.lastSyncedAt,
          minPrice: prices.length ? Math.min(...prices) : 0,
          maxPrice: prices.length ? Math.max(...prices) : 0,
          minCost: costs.length ? Math.min(...costs) : 0,
          maxCost: costs.length ? Math.max(...costs) : 0,
          stock,
        };
      }),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, graphql, actor } = await requireShop(request);
  const { intent, get, getAll } = await readForm(request);
  const ids = getAll("ids").flatMap((v) => v.split(",")).filter(Boolean);
  try {
    switch (intent) {
      case "reprice": {
        let n = 0;
        for (const id of ids) n += await repriceProduct(shop, graphql, id, get("ruleId") || null, actor);
        return { ok: true, message: `${n} variant(s) repriced.` };
      }
      case "auto-on":
        await setAutoUpdate(shop.id, ids, true);
        return { ok: true, message: `Auto-update enabled for ${ids.length} product(s).` };
      case "auto-off":
        await setAutoUpdate(shop.id, ids, false);
        return { ok: true, message: `Auto-update disabled for ${ids.length} product(s).` };
      case "sync-now": {
        const job = await createJobRun({ shopId: shop.id, type: "inventory-sync", total: ids.length });
        await enqueue("inventory-sync", { shopId: shop.id, productIds: ids, jobRunId: job.id, actor });
        return { ok: true, message: `Auto-update queued for ${ids.length} product(s).`, jobRunId: job.id };
      }
      case "delete": {
        const result = await deleteProducts(shop, graphql, ids, { alsoInShopify: get("alsoInShopify") === "true" }, actor);
        return { ok: true, message: `${result.removed} product(s) removed${result.deletedRemote ? `, ${result.deletedRemote} deleted in Shopify` : ""}.` };
      }
      case "refresh": {
        const rows = await Promise.all(ids.map((id) => syncByLocalId(shop, graphql, id)));
        return { ok: true, message: `${rows.filter(Boolean).length}/${ids.length} product(s) refreshed from Shopify.` };
      }
      case "link": {
        const gids = getAll("shopifyProductIds").flatMap((v) => v.split(",")).filter(Boolean);
        let n = 0;
        for (const gid of gids) {
          await importExistingShopifyProduct(shop, graphql, gid, actor);
          n += 1;
        }
        return { ok: true, message: `${n} Shopify product(s) linked. Open each product to map suppliers.` };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

async function syncByLocalId(shop: Awaited<ReturnType<typeof requireShop>>["shop"], graphql: Awaited<ReturnType<typeof requireShop>>["graphql"], id: string) {
  const row = await prisma.product.findFirst({ where: { id, shopId: shop.id }, select: { shopifyProductId: true } });
  if (!row) return null;
  return syncProductFromShopify(shop, graphql, row.shopifyProductId);
}

export default function ProductsPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const shopify = useAppBridge();
  const [search, setSearch] = useState(data.search);
  const [ruleId, setRuleId] = useState("");
  const items = data.list.items;
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(items);

  const submit = (intent: string, extra: Record<string, string> = {}) => {
    fetcher.submit({ intent, ids: selectedResources.join(","), ...extra }, { method: "post" });
    clearSelection();
  };

  const linkExisting = async () => {
    const picked = await shopify.resourcePicker({ type: "product", multiple: true, action: "select" });
    if (!picked || picked.length === 0) return;
    fetcher.submit({ intent: "link", shopifyProductIds: picked.map((p) => p.id).join(",") }, { method: "post" });
  };

  const setFilter = (key: string, value: string) => {
    const sp = new URLSearchParams(params);
    if (value) sp.set(key, value);
    else sp.delete(key);
    sp.delete("page");
    navigate(`?${sp.toString()}`);
  };

  return (
    <Page
      title="My products"
      subtitle={`${data.counts.total} managed · ${data.counts.unmapped} unmapped · ${data.counts.autoUpdate} on auto-update`}
      primaryAction={{ content: "Link existing Shopify product", onAction: linkExisting }}
      secondaryActions={[{ content: "Import list", url: "/app/import" }]}
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
        </Layout.Section>
        <Layout.Section>
          <Card padding="0">
            <div style={{ padding: "var(--p-space-300)" }}>
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="end" wrap>
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <TextField label="Search" labelHidden value={search} onChange={setSearch} autoComplete="off" placeholder="Search products" connectedRight={<Button onClick={() => setFilter("q", search)}>Search</Button>} />
                  </div>
                  <Select label="Mapping" labelHidden options={[{ label: "All products", value: "all" }, { label: "Mapped", value: "mapped" }, { label: "Unmapped", value: "unmapped" }]} value={data.mapped} onChange={(v) => setFilter("mapped", v === "all" ? "" : v)} />
                </InlineStack>
                {selectedResources.length > 0 && (
                  <InlineStack gap="200" wrap>
                    <Select label="Rule" labelHidden options={[{ label: "Default pricing rule", value: "" }, ...data.rules.map((r) => ({ label: r.name, value: r.id }))]} value={ruleId} onChange={setRuleId} />
                    <Button onClick={() => submit("reprice", { ruleId })}>Reprice</Button>
                    <Button onClick={() => submit("sync-now")}>Run auto-update</Button>
                    <Button onClick={() => submit("auto-on")}>Enable auto-update</Button>
                    <Button onClick={() => submit("auto-off")}>Disable auto-update</Button>
                    <Button onClick={() => submit("refresh")}>Refresh from Shopify</Button>
                    <Button tone="critical" onClick={() => submit("delete", { alsoInShopify: "false" })}>
                      Unlink
                    </Button>
                    <Button tone="critical" variant="primary" onClick={() => submit("delete", { alsoInShopify: "true" })}>
                      Delete in Shopify
                    </Button>
                  </InlineStack>
                )}
              </BlockStack>
            </div>
            {items.length === 0 ? (
              <EmptyState heading="No managed products yet" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png" action={{ content: "Find products", url: "/app/search" }} secondaryAction={{ content: "Link existing product", onAction: linkExisting }}>
                <p>Products pushed from the import list, or linked from your store, show up here with their supplier mapping.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "product", plural: "products" }}
                itemCount={items.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[{ title: "Product" }, { title: "Mapping" }, { title: "Cost" }, { title: "Price" }, { title: "Stock" }, { title: "Auto-update" }, { title: "Status" }]}
              >
                {items.map((item, index) => (
                  <IndexTable.Row id={item.id} key={item.id} position={index} selected={selectedResources.includes(item.id)}>
                    <IndexTable.Cell>
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        <Thumb src={item.image} alt={item.title} />
                        <BlockStack gap="050">
                          <Link to={`/app/products/${item.id}`}>
                            <Text as="span" fontWeight="semibold">
                              {item.title}
                            </Text>
                          </Link>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {item.variants} variant(s)
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.mappedRows > 0 ? (
                        <Badge tone={item.mappingEnabled ? "success" : "attention"}>{`${item.mappingType} · ${item.mappedRows} rows`}</Badge>
                      ) : (
                        <Badge tone="critical">Unmapped</Badge>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(item.minCost, data.currency)}
                      {item.minCost !== item.maxCost ? ` – ${formatMoney(item.maxCost, data.currency)}` : ""}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(item.minPrice, data.currency)}
                      {item.minPrice !== item.maxPrice ? ` – ${formatMoney(item.maxPrice, data.currency)}` : ""}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{item.stock}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Badge tone={item.autoUpdate ? "success" : undefined}>{item.autoUpdate ? "On" : "Off"}</Badge>
                        {item.lastSyncedAt && (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {relativeTime(item.lastSyncedAt)}
                          </Text>
                        )}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <StatusBadge status={item.status} />
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
            <div style={{ padding: "var(--p-space-300)" }}>
              <Paginator page={data.list.page} pageSize={data.list.pageSize} total={data.list.total} />
            </div>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
