import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  Link,
  useFetcher,
  useLoaderData,
  useNavigate,
  useSearchParams,
} from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
  useIndexResourceState,
} from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { JobProgress } from "~/components/JobProgress";
import { Paginator } from "~/components/Paginator";
import { Stat } from "~/components/Stat";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import prisma from "~/db.server";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney, pageParam, relativeTime } from "~/lib/format";
import type { I18nKey } from "~/lib/i18n";
import { useJobRun } from "~/lib/use-job-run";
import { useMessage, useT } from "~/lib/use-t";
import { createJobRun } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { listPricingRules } from "~/services/pricing.server";
import {
  countProducts,
  deleteProducts,
  importExistingShopifyProduct,
  listProducts,
  repriceProduct,
  setAutoUpdate,
  syncProductFromShopify,
} from "~/services/products.server";

/** Translation keys for each mapping type, for the mapping badge in the table. */
const MAPPING_TYPE_KEYS: Record<string, I18nKey> = {
  BASIC: "products.mapping.type.basic",
  ADVANCED: "products.mapping.type.advanced",
  BOGO: "products.mapping.type.bogo",
  BUNDLE: "products.mapping.type.bundle",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const search = url.searchParams.get("q") ?? "";
  const mapped = (url.searchParams.get("mapped") ?? "all") as
    "all" | "mapped" | "unmapped";
  const page = pageParam(url.searchParams.get("page"));
  const [list, counts, rules] = await Promise.all([
    listProducts(shop.id, { search, mapped, page }),
    countProducts(shop.id),
    listPricingRules(shop.id),
  ]);

  // Which supplier platform each product on this page is mapped to, so the row
  // can say "AliExpress" without a second click. One query, scoped to the page.
  const productIds = list.items.map((p) => p.id);
  const platformRows = productIds.length
    ? await prisma.variantMapping.findMany({
        where: { productMapping: { productId: { in: productIds } } },
        select: {
          productMapping: { select: { productId: true } },
          supplierVariant: {
            select: { supplierProduct: { select: { platform: true } } },
          },
        },
      })
    : [];
  const platformsByProduct = new Map<string, Set<string>>();
  for (const row of platformRows) {
    const set = platformsByProduct.get(row.productMapping.productId) ?? new Set<string>();
    set.add(row.supplierVariant.supplierProduct.platform);
    platformsByProduct.set(row.productMapping.productId, set);
  }

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
          platforms: [...(platformsByProduct.get(p.id) ?? [])],
        };
      }),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, graphql, actor } = await requireShop(request);
  const { intent, get, getAll } = await readForm(request);
  const ids = getAll("ids")
    .flatMap((v) => v.split(","))
    .filter(Boolean);
  try {
    switch (intent) {
      case "reprice": {
        let n = 0;
        for (const id of ids)
          n += await repriceProduct(shop, graphql, id, get("ruleId") || null, actor);
        return { ok: true, messageKey: "msg.variantsRepriced", messageVars: { n } };
      }
      case "auto-on":
        await setAutoUpdate(shop.id, ids, true);
        return {
          ok: true,
          messageKey: "msg.autoUpdateEnabled",
          messageVars: { n: ids.length },
        };
      case "auto-off":
        await setAutoUpdate(shop.id, ids, false);
        return {
          ok: true,
          messageKey: "msg.autoUpdateDisabled",
          messageVars: { n: ids.length },
        };
      case "sync-now": {
        const job = await createJobRun({
          shopId: shop.id,
          type: "inventory-sync",
          total: ids.length,
        });
        await enqueue("inventory-sync", {
          shopId: shop.id,
          productIds: ids,
          jobRunId: job.id,
          actor,
        });
        return {
          ok: true,
          messageKey: "msg.autoUpdateQueued",
          messageVars: { n: ids.length },
          jobRunId: job.id,
        };
      }
      case "delete": {
        const result = await deleteProducts(
          shop,
          graphql,
          ids,
          { alsoInShopify: get("alsoInShopify") === "true" },
          actor,
        );
        return result.deletedRemote
          ? {
              ok: true,
              messageKey: "msg.productsDeletedRemote",
              messageVars: { n: result.removed, remote: result.deletedRemote },
            }
          : {
              ok: true,
              messageKey: "msg.productsDeleted",
              messageVars: { n: result.removed },
            };
      }
      case "refresh": {
        const rows = await Promise.all(ids.map((id) => syncByLocalId(shop, graphql, id)));
        return {
          ok: true,
          messageKey: "msg.productsRefreshed",
          messageVars: { n: rows.filter(Boolean).length, total: ids.length },
        };
      }
      case "link": {
        const gids = getAll("shopifyProductIds")
          .flatMap((v) => v.split(","))
          .filter(Boolean);
        let n = 0;
        for (const gid of gids) {
          await importExistingShopifyProduct(shop, graphql, gid, actor);
          n += 1;
        }
        return { ok: true, messageKey: "msg.productsLinked", messageVars: { n } };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

async function syncByLocalId(
  shop: Awaited<ReturnType<typeof requireShop>>["shop"],
  graphql: Awaited<ReturnType<typeof requireShop>>["graphql"],
  id: string,
) {
  const row = await prisma.product.findFirst({
    where: { id, shopId: shop.id },
    select: { shopifyProductId: true },
  });
  if (!row) return null;
  return syncProductFromShopify(shop, graphql, row.shopifyProductId);
}

/** Which confirmation is open; each one carries the ids it was opened for. */
type Confirm = { kind: "reprice" | "unlink" | "delete-remote"; ids: string[] } | null;

export default function ProductsPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as
    | {
        ok?: boolean;
        error?: string;
        messageKey?: string;
        messageVars?: Record<string, string | number>;
        jobRunId?: string;
      }
    | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const shopify = useAppBridge();
  const [search, setSearch] = useState(data.search);
  const [ruleId, setRuleId] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const items = data.list.items;
  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange,
    clearSelection,
  } = useIndexResourceState(items);
  const { jobRunId, clearJobRun } = useJobRun(result);

  const busyIntent =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("intent") ?? "") : null;
  const busy = busyIntent !== null;

  const submit = (intent: string, ids: string[], extra: Record<string, string> = {}) => {
    fetcher.submit({ intent, ids: ids.join(","), ...extra }, { method: "post" });
    clearSelection();
  };

  const linkExisting = async () => {
    const picked = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
    });
    if (!picked || picked.length === 0) return;
    fetcher.submit(
      { intent: "link", shopifyProductIds: picked.map((p) => p.id).join(",") },
      { method: "post" },
    );
  };

  const setFilter = (key: string, value: string) => {
    const sp = new URLSearchParams(params);
    if (value) sp.set(key, value);
    else sp.delete(key);
    sp.delete("page");
    navigate(`?${sp.toString()}`);
  };

  const tabs = [
    { id: "all", content: `${t("products.filter.all")} (${data.counts.total})` },
    { id: "mapped", content: `${t("products.filter.mapped")} (${data.counts.mapped})` },
    {
      id: "unmapped",
      content: `${t("products.filter.unmapped")} (${data.counts.unmapped})`,
    },
  ];
  const selectedTab = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === data.mapped),
  );
  const filtered = Boolean(data.search) || data.mapped !== "all";

  // A refresh that skipped rows is a warning, not a success.
  const bannerTone =
    result?.messageKey === "msg.productsRefreshed" &&
    Number(result.messageVars?.n ?? 0) < Number(result.messageVars?.total ?? 0)
      ? "warning"
      : "success";

  const confirmAction = () => {
    if (!confirm) return;
    if (confirm.kind === "reprice") submit("reprice", confirm.ids, { ruleId });
    if (confirm.kind === "unlink")
      submit("delete", confirm.ids, { alsoInShopify: "false" });
    if (confirm.kind === "delete-remote")
      submit("delete", confirm.ids, { alsoInShopify: "true" });
    setConfirm(null);
  };

  const moneyRange = (min: number, max: number) =>
    min !== max
      ? `${formatMoney(min, data.currency)} – ${formatMoney(max, data.currency)}`
      : formatMoney(min, data.currency);

  return (
    <Page
      fullWidth
      title={t("page.products.title")}
      subtitle={t("products.index.subtitle")}
      primaryAction={{
        content: t("products.action.linkExisting"),
        onAction: linkExisting,
        loading: busyIntent === "link",
      }}
      secondaryActions={[{ content: t("nav.import"), url: "/app/import" }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <JobProgress jobRunId={jobRunId} onDone={clearJobRun} />
            {actionMessage && result?.ok && (
              <Banner tone={bannerTone}>
                <p>{actionMessage}</p>
              </Banner>
            )}
            {result?.error && (
              <Banner tone="critical">
                <p>{result.error}</p>
              </Banner>
            )}
            <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
              <Stat
                label={t("products.index.stat.managed")}
                value={String(data.counts.total)}
              />
              <Stat
                label={t("products.index.stat.mapped")}
                value={String(data.counts.mapped)}
                tone={data.counts.mapped > 0 ? "success" : "subdued"}
              />
              <Stat
                label={t("products.index.stat.unmapped")}
                value={String(data.counts.unmapped)}
                tone={data.counts.unmapped > 0 ? "warning" : "subdued"}
                hint={
                  data.counts.unmapped > 0
                    ? t("products.index.stat.unmappedHint")
                    : undefined
                }
              />
              <Stat
                label={t("products.index.stat.autoUpdate")}
                value={String(data.counts.autoUpdate)}
                hint={t("products.index.stat.autoUpdateHint")}
              />
            </InlineGrid>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          {data.counts.total === 0 && !filtered ? (
            <EmptyScreen
              heading={t("products.empty.heading")}
              body={t("products.empty.body")}
              action={{ content: t("nav.search"), url: "/app/search" }}
            />
          ) : (
            <Card padding="0">
              <Tabs
                tabs={tabs}
                selected={selectedTab}
                onSelect={(i) =>
                  setFilter("mapped", tabs[i].id === "all" ? "" : tabs[i].id)
                }
                fitted
              />
              <Box padding="300">
                <TextField
                  label={t("action.search")}
                  labelHidden
                  value={search}
                  onChange={setSearch}
                  autoComplete="off"
                  placeholder={t("products.searchPlaceholder")}
                  clearButton
                  onClearButtonClick={() => {
                    setSearch("");
                    setFilter("q", "");
                  }}
                  connectedRight={
                    <Button onClick={() => setFilter("q", search)}>
                      {t("action.search")}
                    </Button>
                  }
                />
              </Box>
              {items.length === 0 ? (
                <EmptyScreen
                  compact
                  heading={t("products.index.empty.filtered.heading")}
                  body={t("products.index.empty.filtered.body")}
                  action={{
                    content: t("products.index.empty.clearFilters"),
                    onAction: () => {
                      setSearch("");
                      navigate("?");
                    },
                  }}
                />
              ) : (
                <IndexTable
                  resourceName={{
                    singular: t("products.resource.singular"),
                    plural: t("products.resource.plural"),
                  }}
                  itemCount={items.length}
                  selectedItemsCount={
                    allResourcesSelected ? "All" : selectedResources.length
                  }
                  onSelectionChange={handleSelectionChange}
                  loading={busy}
                  promotedBulkActions={[
                    {
                      content: t("products.action.reprice"),
                      disabled: busy,
                      onAction: () =>
                        setConfirm({ kind: "reprice", ids: selectedResources }),
                    },
                    {
                      content: t("products.action.runAutoUpdate"),
                      disabled: busy,
                      onAction: () => submit("sync-now", selectedResources),
                    },
                    {
                      content: t("products.action.enableAutoUpdate"),
                      disabled: busy,
                      onAction: () => submit("auto-on", selectedResources),
                    },
                  ]}
                  bulkActions={[
                    {
                      content: t("products.action.disableAutoUpdate"),
                      disabled: busy,
                      onAction: () => submit("auto-off", selectedResources),
                    },
                    {
                      content: t("products.action.refreshFromShopify"),
                      disabled: busy,
                      onAction: () => submit("refresh", selectedResources),
                    },
                    {
                      content: t("products.action.unlink"),
                      disabled: busy,
                      onAction: () =>
                        setConfirm({ kind: "unlink", ids: selectedResources }),
                    },
                    {
                      content: t("products.action.deleteInShopify"),
                      disabled: busy,
                      onAction: () =>
                        setConfirm({ kind: "delete-remote", ids: selectedResources }),
                    },
                  ]}
                  headings={[
                    { title: t("products.column.product") },
                    { title: t("products.column.mapping") },
                    { title: t("common.supplier") },
                    { title: t("common.variants"), alignment: "end" },
                    { title: t("common.stock"), alignment: "end" },
                    { title: t("common.cost"), alignment: "end" },
                    { title: t("common.price"), alignment: "end" },
                    { title: t("products.column.autoUpdate") },
                    { title: t("common.status") },
                  ]}
                >
                  {items.map((item, index) => (
                    <IndexTable.Row
                      id={item.id}
                      key={item.id}
                      position={index}
                      selected={selectedResources.includes(item.id)}
                    >
                      <IndexTable.Cell>
                        <InlineStack gap="300" blockAlign="center" wrap={false}>
                          <Thumb src={item.image} alt={item.title} />
                          <Link to={`/app/products/${item.id}`}>
                            <Text as="span" fontWeight="semibold">
                              {item.title}
                            </Text>
                          </Link>
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {item.mappedRows === 0 ? (
                          <StatusBadge status="FAILED" label={t("common.notMapped")} />
                        ) : item.mappingEnabled ? (
                          <StatusBadge
                            status="ENABLED"
                            label={t("products.index.mappingRows", {
                              type: t(
                                MAPPING_TYPE_KEYS[item.mappingType ?? "BASIC"] ??
                                  "products.mapping.type.basic",
                              ),
                              n: item.mappedRows,
                            })}
                          />
                        ) : (
                          <StatusBadge
                            status="DISABLED"
                            label={t("products.index.mappingOff")}
                          />
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {item.platforms.length > 0 ? (
                          <InlineStack gap="100">
                            {item.platforms.map((platform) => (
                              <PlatformBadge key={platform} platform={platform} />
                            ))}
                          </InlineStack>
                        ) : (
                          <Text as="span" tone="subdued">
                            —
                          </Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end">
                          {String(item.variants)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text
                          as="span"
                          numeric
                          alignment="end"
                          tone={item.stock <= 0 ? "critical" : undefined}
                        >
                          {String(item.stock)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end">
                          {moneyRange(item.minCost, item.maxCost)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end">
                          {moneyRange(item.minPrice, item.maxPrice)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <StatusBadge
                            status={item.autoUpdate ? "ENABLED" : "DISABLED"}
                            label={item.autoUpdate ? t("common.on") : t("common.off")}
                          />
                          <Text as="span" tone="subdued" variant="bodySm">
                            {item.lastSyncedAt
                              ? relativeTime(item.lastSyncedAt)
                              : t("products.index.neverSynced")}
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <StatusBadge status={item.status} />
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
              {items.length > 0 && (
                <Box padding="300">
                  <Paginator
                    page={data.list.page}
                    pageSize={data.list.pageSize}
                    total={data.list.total}
                  />
                </Box>
              )}
            </Card>
          )}
        </Layout.Section>
      </Layout>

      <Modal
        open={confirm?.kind === "reprice"}
        onClose={() => setConfirm(null)}
        title={t("products.index.reprice.title", { n: confirm?.ids.length ?? 0 })}
        primaryAction={{
          content: t("products.action.reprice"),
          onAction: confirmAction,
          loading: busyIntent === "reprice",
        }}
        secondaryActions={[
          { content: t("action.cancel"), onAction: () => setConfirm(null) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">{t("products.index.reprice.body")}</Text>
            <Select
              label={t("products.pricing.rule")}
              options={[
                { label: t("products.pricing.defaultRule"), value: "" },
                ...data.rules.map((r) => ({ label: r.name, value: r.id })),
              ]}
              value={ruleId}
              onChange={setRuleId}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={confirm?.kind === "unlink" || confirm?.kind === "delete-remote"}
        onClose={() => setConfirm(null)}
        title={
          confirm?.kind === "delete-remote"
            ? t("products.index.deleteRemote.title", { n: confirm.ids.length })
            : t("products.index.unlink.title", { n: confirm?.ids.length ?? 0 })
        }
        primaryAction={{
          content:
            confirm?.kind === "delete-remote"
              ? t("products.action.deleteInShopify")
              : t("products.action.unlink"),
          destructive: true,
          onAction: confirmAction,
          loading: busyIntent === "delete",
        }}
        secondaryActions={[
          { content: t("action.cancel"), onAction: () => setConfirm(null) },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            {confirm?.kind === "delete-remote"
              ? t("products.index.deleteRemote.body")
              : t("products.index.unlink.body")}
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
