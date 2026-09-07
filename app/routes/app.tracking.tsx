import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, Banner, BlockStack, Button, Card, EmptyState, IndexTable, InlineStack, Layout, Page, Tabs, Text } from "@shopify/polaris";
import prisma from "~/db.server";
import { Paginator } from "~/components/Paginator";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, relativeTime } from "~/lib/format";
import { syncOpenPurchaseOrders, syncPendingTracking } from "~/services/fulfillment.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "all";
  const page = Number(url.searchParams.get("page") ?? 1);
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
      return { ok: true, message: `${result.synced} synced, ${result.failed} failed.` };
    }
    if (intent === "poll-suppliers") {
      const result = await syncOpenPurchaseOrders(shop, { limit: 100 });
      return { ok: true, message: `Checked ${result.checked} supplier order(s); ${result.changed} updated.` };
    }
    return { ok: false, error: "Unknown action" };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function TrackingPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const tabs = [
    { id: "all", content: `All (${data.counts.all})` },
    { id: "unsynced", content: `Not synced (${data.counts.unsynced})` },
    { id: "failed", content: `Sync failed (${data.counts.failed})` },
    { id: "delivered", content: "Delivered" },
  ];
  const selected = Math.max(0, tabs.findIndex((t) => t.id === data.filter));

  return (
    <Page
      title="Tracking"
      subtitle={`${data.awaitingShipment} supplier order(s) waiting for shipment`}
      primaryAction={{ content: "Sync tracking to Shopify", onAction: () => fetcher.submit({ intent: "sync-tracking" }, { method: "post" }), loading: fetcher.state !== "idle", disabled: data.counts.unsynced === 0 }}
      secondaryActions={[{ content: "Check suppliers for new tracking", onAction: () => fetcher.submit({ intent: "poll-suppliers" }, { method: "post" }) }]}
    >
      <Layout>
        <Layout.Section>
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
              <EmptyState heading="No tracking numbers yet" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>Tracking numbers appear here once suppliers ship, and are pushed to Shopify as fulfilments.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "tracking number", plural: "tracking numbers" }}
                itemCount={data.list.items.length}
                selectable={false}
                headings={[{ title: "Order" }, { title: "Supplier order" }, { title: "Tracking" }, { title: "Carrier" }, { title: "Status" }, { title: "Shopify" }, { title: "Received" }]}
              >
                {data.list.items.map((t, index) => (
                  <IndexTable.Row id={t.id} key={t.id} position={index}>
                    <IndexTable.Cell>
                      <Link to={`/app/orders/${t.orderId}`}>{t.orderName}</Link>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {" "}
                        {t.country}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100">
                        <PlatformBadge platform={t.platform} />
                        <Text as="span" variant="bodySm">
                          {t.externalOrderId}
                        </Text>
                        <StatusBadge status={t.poStatus} />
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {t.url ? (
                        <Button variant="plain" url={t.url} external>
                          {t.number}
                        </Button>
                      ) : (
                        t.number
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{t.carrier ?? "—"}</IndexTable.Cell>
                    <IndexTable.Cell>{t.status ? <Badge>{t.status}</Badge> : "—"}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Badge tone={t.synced ? "success" : t.syncError ? "critical" : "attention"}>{t.synced ? "Fulfilled" : t.syncError ? "Failed" : "Pending"}</Badge>
                        {t.syncError && (
                          <Text as="span" tone="critical" variant="bodySm">
                            {t.syncError}
                          </Text>
                        )}
                        {t.syncedAt && (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {formatDate(t.syncedAt)}
                          </Text>
                        )}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{relativeTime(t.createdAt)}</IndexTable.Cell>
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
