import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, Banner, BlockStack, Button, Card, EmptyState, IndexTable, InlineStack, Layout, Page, Tabs, Text } from "@shopify/polaris";
import prisma from "~/db.server";
import { Paginator } from "~/components/Paginator";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, pageParam, relativeTime } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
import { syncOpenPurchaseOrders, syncPendingTracking } from "~/services/fulfillment.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "all";
  const page = pageParam(url.searchParams.get("page"));
  const pageSize = 50;
  const where = {
    purchaseOrder: { order: { shopId: shop.id } },
    ...(filter === "unsynced" ? { syncedToShopify: false } : {}),
    ...(filter === "failed" ? { syncError: { not: null }, syncedToShopify: false } : {}),
    ...(filter === "delivered" ? { status: { contains: "DELIVER", mode: "insensitive" as const } } : {}),
  };
  const [rows, total, counts] = await Promise.all([
    prisma.trackingNumber.findMany({ where, include: { purchaseOrder: { include: { order: { select: { id: true, name: true, countryCode: true } } } } }, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.trackingNumber.count({ where }),
    Promise.all([
      prisma.trackingNumber.count({ where: { purchaseOrder: { order: { shopId: shop.id } } } }),
      prisma.trackingNumber.count({ where: { purchaseOrder: { order: { shopId: shop.id } }, syncedToShopify: false } }),
      prisma.trackingNumber.count({ where: { purchaseOrder: { order: { shopId: shop.id } }, syncedToShopify: false, syncError: { not: null } } }),
    ]),
  ]);
  const awaitingShipment = await prisma.purchaseOrder.count({ where: { order: { shopId: shop.id }, status: { in: ["PLACED", "AWAITING_PAYMENT", "PAID"] } } });
  return {
    filter,
    counts: { all: counts[0], unsynced: counts[1], failed: counts[2] },
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

export default function TrackingPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const tabs = [
    { id: "all", content: `${t("common.all")} (${data.counts.all})` },
    { id: "unsynced", content: `${t("tracking.tab.unsynced")} (${data.counts.unsynced})` },
    { id: "failed", content: `${t("tracking.tab.failed")} (${data.counts.failed})` },
    { id: "delivered", content: t("tracking.tab.delivered") },
  ];
  const selected = Math.max(0, tabs.findIndex((tab) => tab.id === data.filter));

  return (
    <Page
      title={t("page.tracking.title")}
      subtitle={`${data.awaitingShipment} ${t("tracking.awaitingShipment")}`}
      primaryAction={{ content: t("tracking.syncToShopify"), onAction: () => fetcher.submit({ intent: "sync-tracking" }, { method: "post" }), loading: fetcher.state !== "idle", disabled: data.counts.unsynced === 0 }}
      secondaryActions={[{ content: t("tracking.checkSuppliers"), onAction: () => fetcher.submit({ intent: "poll-suppliers" }, { method: "post" }) }]}
    >
      <Layout>
        <Layout.Section>
          {actionMessage && (
            <Banner tone="success">
              <p>{actionMessage}</p>
            </Banner>
          )}
          {result?.error && (
            <Banner tone="critical">
              <p>{result.error}</p>
            </Banner>
          )}
        </Layout.Section>
        <Layout.Section>
          <Card padding="0">
            <Tabs
              tabs={tabs}
              selected={selected}
              onSelect={(i) => {
                const sp = new URLSearchParams(params);
                sp.set("filter", tabs[i].id);
                sp.delete("page");
                navigate(`?${sp.toString()}`);
              }}
            />
            {data.list.items.length === 0 ? (
              <EmptyState heading={t("tracking.empty")} image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>{t("tracking.emptyBody")}</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: t("tracking.resourceSingular"), plural: t("tracking.resourcePlural") }}
                itemCount={data.list.items.length}
                selectable={false}
                headings={[{ title: t("tracking.col.order") }, { title: t("common.supplierOrder") }, { title: t("tracking.col.tracking") }, { title: t("tracking.col.carrier") }, { title: t("common.status") }, { title: "Shopify" }, { title: t("tracking.col.received") }]}
              >
                {data.list.items.map((row, index) => (
                  <IndexTable.Row id={row.id} key={row.id} position={index}>
                    <IndexTable.Cell>
                      <Link to={`/app/orders/${row.orderId}`}>{row.orderName}</Link>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {" "}
                        {row.country}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100">
                        <PlatformBadge platform={row.platform} />
                        <Text as="span" variant="bodySm">
                          {row.externalOrderId}
                        </Text>
                        <StatusBadge status={row.poStatus} />
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {row.url ? (
                        <Button variant="plain" url={row.url} external>
                          {row.number}
                        </Button>
                      ) : (
                        row.number
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{row.carrier ?? "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{row.status ? <Badge>{row.status}</Badge> : "—"}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Badge tone={row.synced ? "success" : row.syncError ? "critical" : "attention"}>{row.synced ? t("stage.FULFILLED") : row.syncError ? t("stage.FAILED") : t("stage.PENDING")}</Badge>
                        {row.syncError && (
                          <Text as="span" tone="critical" variant="bodySm">
                            {row.syncError}
                          </Text>
                        )}
                        {row.syncedAt && (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {formatDate(row.syncedAt)}
                          </Text>
                        )}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{relativeTime(row.createdAt)}</IndexTable.Cell>
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
