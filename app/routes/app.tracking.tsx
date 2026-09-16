import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Card, IndexTable, InlineGrid, InlineStack, Layout, Link as PolarisLink, Page, Tabs, Text, Tooltip } from "@shopify/polaris";
import prisma from "~/db.server";
import { EmptyScreen } from "~/components/EmptyScreen";
import { Paginator } from "~/components/Paginator";
import { Stat } from "~/components/Stat";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, pageParam, relativeTime } from "~/lib/format";
import type { I18nVars } from "~/lib/i18n";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
import { syncOpenPurchaseOrders, syncPendingTracking } from "~/services/fulfillment.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "all";
  const page = pageParam(url.searchParams.get("page"));
  const pageSize = 50;
  const delivered = { status: { contains: "DELIVER", mode: "insensitive" as const } };
  const where = {
    purchaseOrder: { order: { shopId: shop.id } },
    ...(filter === "unsynced" ? { syncedToShopify: false } : {}),
    ...(filter === "failed" ? { syncError: { not: null }, syncedToShopify: false } : {}),
    ...(filter === "delivered" ? delivered : {}),
  };
  const [rows, total, counts] = await Promise.all([
    prisma.trackingNumber.findMany({ where, include: { purchaseOrder: { include: { order: { select: { id: true, name: true, countryCode: true } } } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.trackingNumber.count({ where }),
    Promise.all([
      prisma.trackingNumber.count({ where: { purchaseOrder: { order: { shopId: shop.id } } } }),
      prisma.trackingNumber.count({ where: { purchaseOrder: { order: { shopId: shop.id } }, syncedToShopify: false } }),
      prisma.trackingNumber.count({ where: { purchaseOrder: { order: { shopId: shop.id } }, syncedToShopify: false, syncError: { not: null } } }),
      prisma.trackingNumber.count({ where: { purchaseOrder: { order: { shopId: shop.id } }, ...delivered } }),
    ]),
  ]);
  const awaitingShipment = await prisma.purchaseOrder.count({ where: { order: { shopId: shop.id }, status: { in: ["PLACED", "AWAITING_PAYMENT", "PAID"] } } });
  return {
    filter,
    counts: { all: counts[0], unsynced: counts[1], failed: counts[2], delivered: counts[3] },
    awaitingShipment,
    list: {
      page,
      pageSize,
      total,
      items: rows.map((t) => ({
        id: t.id,
        number: t.number,
        carrier: t.carrierName ?? t.carrierCode,
        url: t.trackingUrl,
        status: t.status,
        synced: t.syncedToShopify,
        syncedAt: t.syncedAt,
        syncError: t.syncError,
        createdAt: t.createdAt,
        orderId: t.purchaseOrder.order.id,
        orderName: t.purchaseOrder.order.name,
        country: t.purchaseOrder.order.countryCode,
        platform: t.purchaseOrder.platform,
        externalOrderId: t.purchaseOrder.externalOrderId,
        poStatus: t.purchaseOrder.status,
      })),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, graphql } = await requireShop(request);
  const { intent } = await readForm(request);
  try {
    if (intent === "sync-tracking") {
      const result = await syncPendingTracking(shop, undefined, graphql);
      return { ok: true, messageKey: "msg.trackingSyncResult", messageVars: { n: result.synced, failed: result.failed } };
    }
    if (intent === "poll-suppliers") {
      const result = await syncOpenPurchaseOrders(shop, { limit: 100 });
      return { ok: true, messageKey: "msg.purchaseOrdersChecked", messageVars: { n: result.checked, changed: result.changed } };
    }
    return { ok: false, error: "Unknown action" };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

type ActionResult = { ok?: boolean; message?: string; messageKey?: string; messageVars?: I18nVars; error?: string };

const TAB_IDS = ["all", "unsynced", "failed", "delivered"] as const;

export default function TrackingPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const result = fetcher.data as ActionResult | undefined;
  const actionMessage = useMessage(result);
  const actionError = useErrorMessage(result);

  const busy = fetcher.state !== "idle";
  const pendingIntent = busy ? fetcher.formData?.get("intent") : null;
  const run = (intent: "sync-tracking" | "poll-suppliers") => fetcher.submit({ intent }, { method: "post" });

  const tabLabel = (id: (typeof TAB_IDS)[number]) =>
    id === "all" ? t("common.all") : id === "unsynced" ? t("tracking.tab.unsynced") : id === "failed" ? t("tracking.tab.failed") : t("tracking.tab.delivered");
  const tabs = TAB_IDS.map((id) => ({ id, content: `${tabLabel(id)} (${data.counts[id]})` }));
  const selected = Math.max(0, tabs.findIndex((tab) => tab.id === data.filter));
  const selectTab = (index: number) => {
    const sp = new URLSearchParams(params);
    if (tabs[index].id === "all") sp.delete("filter");
    else sp.set("filter", tabs[index].id);
    sp.delete("page");
    navigate(`?${sp.toString()}`);
  };

  // A sync that finished with failures is a warning the merchant should read,
  // not a green "done".
  const failedCount = Number(result?.messageVars?.failed ?? 0);
  // "Checked 100 supplier order(s); 0 updated." is not a success either, so the
  // tone follows what actually changed rather than the fact that a job ran.
  const changedCount = Number(result?.messageVars?.changed ?? result?.messageVars?.n ?? 0);
  const bannerTone =
    failedCount > 0 ? "warning" : changedCount === 0 ? "info" : "success";

  return (
    <Page
      fullWidth
      title={t("page.tracking.title")}
      subtitle={t("tracking.subtitle")}
      primaryAction={{
        content: t("tracking.syncToShopify"),
        onAction: () => run("sync-tracking"),
        loading: pendingIntent === "sync-tracking",
        disabled: busy || data.counts.unsynced === 0,
      }}
      secondaryActions={[{ content: t("tracking.checkSuppliers"), onAction: () => run("poll-suppliers"), loading: pendingIntent === "poll-suppliers", disabled: busy }]}
    >
      <Layout>
        {(actionMessage || actionError) && (
          <Layout.Section>
            <BlockStack gap="300">
              {actionMessage && (
                <Banner tone={bannerTone}>
                  <p>{actionMessage}</p>
                </Banner>
              )}
              {actionError && (
                <Banner tone="critical">
                  <p>{actionError}</p>
                </Banner>
              )}
            </BlockStack>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
            <Stat label={t("tracking.stat.awaitingShipment")} value={String(data.awaitingShipment)} hint={t("tracking.stat.supplierOrders")} tone={data.awaitingShipment > 0 ? "default" : "subdued"} />
            <Stat
              label={t("tracking.tab.unsynced")}
              value={String(data.counts.unsynced)}
              hint={data.counts.unsynced > 0 ? t("tracking.stat.notSyncedHint") : t("tracking.stat.allSynced")}
              tone={data.counts.unsynced > 0 ? "warning" : "success"}
            />
            <Stat
              label={t("tracking.tab.failed")}
              value={String(data.counts.failed)}
              hint={data.counts.failed > 0 ? t("tracking.stat.failedHint") : undefined}
              tone={data.counts.failed > 0 ? "critical" : "subdued"}
            />
            <Stat label={t("tracking.tab.delivered")} value={String(data.counts.delivered)} hint={t("tracking.stat.deliveredHint", { n: data.counts.all })} tone={data.counts.delivered > 0 ? "success" : "subdued"} />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selected} onSelect={selectTab} />
            {data.counts.all === 0 ? (
              <EmptyScreen heading={t("tracking.empty")} body={t("tracking.emptyBody")} action={{ content: t("tracking.checkSuppliers"), onAction: () => run("poll-suppliers") }} />
            ) : data.list.items.length === 0 ? (
              <EmptyScreen heading={t("tracking.emptyTab")} body={t("tracking.emptyTabBody")} action={{ content: t("tracking.viewAll"), onAction: () => selectTab(0) }} />
            ) : (
              <IndexTable
                resourceName={{ singular: t("tracking.resourceSingular"), plural: t("tracking.resourcePlural") }}
                itemCount={data.list.items.length}
                selectable={false}
                headings={[
                  { title: t("tracking.col.order") },
                  { title: t("common.supplierOrder") },
                  { title: t("tracking.col.tracking") },
                  { title: t("tracking.col.carrier") },
                  { title: t("common.status") },
                  { title: t("tracking.col.shopify") },
                  { title: t("tracking.col.received") },
                ]}
              >
                {data.list.items.map((row, index) => {
                  const delivered = /deliver/i.test(row.status ?? "");
                  return (
                    <IndexTable.Row id={row.id} key={row.id} position={index}>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Link to={`/app/orders/${row.orderId}`}>
                            <Text as="span" fontWeight="semibold">
                              {row.orderName}
                            </Text>
                          </Link>
                          {row.country && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              {row.country}
                            </Text>
                          )}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <InlineStack gap="100" blockAlign="center">
                            <PlatformBadge platform={row.platform} />
                            <StatusBadge status={row.poStatus} />
                          </InlineStack>
                          {row.externalOrderId && (
                            <Text as="span" variant="bodySm">
                              {row.externalOrderId}
                            </Text>
                          )}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.url ? (
                          <PolarisLink url={row.url} target="_blank">
                            <Text as="span" numeric>
                              {row.number}
                            </Text>
                          </PolarisLink>
                        ) : (
                          <Text as="span" numeric>
                            {row.number}
                          </Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>{row.carrier ?? "—"}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {row.status ? (
                          <Badge tone={delivered ? "success" : "info"}>{row.status}</Badge>
                        ) : (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {t("tracking.noStatusYet")}
                          </Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <InlineStack gap="100" blockAlign="center">
                            <Badge tone={row.synced ? "success" : row.syncError ? "critical" : "attention"}>{row.synced ? t("tracking.sync.synced") : row.syncError ? t("tracking.sync.failed") : t("tracking.sync.pending")}</Badge>
                            {row.syncedAt && (
                              <Text as="span" tone="subdued" variant="bodySm">
                                {formatDate(row.syncedAt)}
                              </Text>
                            )}
                          </InlineStack>
                          {row.syncError && (
                            <Text as="span" tone="critical" variant="bodySm">
                              {row.syncError}
                            </Text>
                          )}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Tooltip content={formatDate(row.createdAt)}>
                          <Text as="span">{relativeTime(row.createdAt)}</Text>
                        </Tooltip>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
            {data.list.total > data.list.pageSize && (
              <Box padding="300">
                <Paginator page={data.list.page} pageSize={data.list.pageSize} total={data.list.total} />
              </Box>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
