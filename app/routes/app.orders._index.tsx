import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, Card, Form, IndexTable, InlineGrid, InlineStack, Layout, Modal, Page, Tabs, Text, TextField, Tooltip, useIndexResourceState } from "@shopify/polaris";
import type { OrderStage } from "@prisma/client";
import { EmptyScreen } from "~/components/EmptyScreen";
import { JobProgress } from "~/components/JobProgress";
import { Paginator } from "~/components/Paginator";
import { Stat } from "~/components/Stat";
import { StatusBadge } from "~/components/StatusBadge";
import { STAGE_ORDER } from "~/domain/orders/pipeline";
import type { OrderIssue } from "~/domain/orders/pipeline";
import { readForm, requireShop } from "~/lib/auth.server";
import { downloadAuthed } from "~/lib/download.client";
import { errorMessage } from "~/lib/errors";
import { formatDate, formatMoney, pageParam } from "~/lib/format";
import { useJobRun } from "~/lib/use-job-run";
import { useErrorMessage, useT } from "~/lib/use-t";
import { createJobRun } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { countOrdersByStage, listOrders } from "~/services/orders.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const stage = (url.searchParams.get("stage") ?? "ALL") as OrderStage | "ALL";
  const search = url.searchParams.get("q") ?? "";
  const page = pageParam(url.searchParams.get("page"));
  const [list, counts] = await Promise.all([listOrders(shop.id, { stage, search, page, pageSize: shop.parsedSettings.ui.ordersPageSize }), countOrdersByStage(shop.id)]);
  return {
    currency: shop.currency,
    stage,
    search,
    counts,
    list: {
      ...list,
      items: list.items.map((o) => ({
        id: o.id,
        name: o.name,
        createdAt: o.shopifyCreatedAt,
        customer: o.customerName ?? o.customerEmail ?? "—",
        country: o.countryCode ?? "—",
        total: o.totalPrice.toString(),
        cost: Number(o.supplierCost) + Number(o.supplierShipping),
        stage: o.stage,
        financialStatus: o.financialStatus,
        issues: (o.issues as unknown as OrderIssue[]) ?? [],
        items: o.lineItems.reduce((n, li) => n + li.quantity, 0),
        managed: o.lineItems.filter((li) => li.productVariantId).length,
        purchaseOrders: o.purchaseOrders.map((po) => ({ id: po.id, platform: po.platform, externalOrderId: po.externalOrderId, status: po.status, tracking: po.trackings.map((t) => t.number) })),
      })),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, actor } = await requireShop(request);
  const { intent, getAll, get } = await readForm(request);
  const ids = getAll("ids").flatMap((v) => v.split(",")).filter(Boolean);
  try {
    switch (intent) {
      case "place": {
        if (ids.length === 0) return { ok: false, error: "Select at least one order." };
        const job = await createJobRun({ shopId: shop.id, type: "place-orders", total: ids.length, payload: { ids } });
        await enqueue("place-orders", { shopId: shop.id, orderIds: ids, jobRunId: job.id, actor });
        return { ok: true, jobRunId: job.id };
      }
      case "sync": {
        const days = Number(get("days") || 30);
        const job = await createJobRun({ shopId: shop.id, type: "sync-orders", payload: { days } });
        await enqueue("sync-orders", { shopId: shop.id, days, jobRunId: job.id }, { dedupeKey: `sync-orders-${shop.id}` });
        return { ok: true, jobRunId: job.id };
      }
      case "sync-suppliers": {
        const job = await createJobRun({ shopId: shop.id, type: "sync-purchase-orders" });
        await enqueue("sync-purchase-orders", { shopId: shop.id, jobRunId: job.id }, { dedupeKey: `sync-po-manual-${shop.id}` });
        return { ok: true, jobRunId: job.id };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function OrdersPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(data.search);
  const [confirmSend, setConfirmSend] = useState(false);
  const items = data.list.items;
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(items);

  const result = fetcher.data as { ok?: boolean; error?: string; jobRunId?: string } | undefined;
  const errorText = useErrorMessage(result);
  const { jobRunId, clearJobRun } = useJobRun(result, clearSelection);
  const busy = fetcher.state !== "idle";

  const totalCount = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const tabs = [{ id: "ALL", content: `${t("common.all")} (${totalCount})` }, ...STAGE_ORDER.map((s) => ({ id: s, content: `${t(`stage.${s}`)} (${data.counts[s]})` }))];
  const selectedTab = Math.max(0, tabs.findIndex((tab) => tab.id === data.stage));
  // Only orders that are awaiting order can be sent; the rest of a selection is
  // named in the confirmation so nothing is silently skipped.
  const placeable = selectedResources.filter((id) => items.find((i) => i.id === id)?.stage === "AWAITING_ORDER");
  const skipped = selectedResources.length - placeable.length;

  const setParam = (key: string, value: string) => {
    const sp = new URLSearchParams(params);
    if (value) sp.set(key, value);
    else sp.delete(key);
    sp.delete("page");
    navigate(`?${sp.toString()}`);
  };
  const submit = (payload: Record<string, string>) => fetcher.submit(payload, { method: "post" });
  const sendSelected = () => {
    setConfirmSend(false);
    submit({ intent: "place", ids: placeable.join(",") });
  };

  const needsAttention = data.counts.PENDING + data.counts.FAILED;
  const filtered = data.stage !== "ALL" || data.search !== "";

  return (
    <Page
      fullWidth
      title={t("page.orders.title")}
      subtitle={t("orders.list.subtitle")}
      primaryAction={{
        content: placeable.length ? t("orders.list.action.sendToSupplierCount", { n: placeable.length }) : t("orders.list.action.sendToSupplier"),
        disabled: placeable.length === 0,
        loading: busy,
        onAction: () => setConfirmSend(true),
      }}
      secondaryActions={[
        { content: t("orders.syncFromShopify"), loading: busy, onAction: () => submit({ intent: "sync", days: "30" }) },
        { content: t("orders.checkSupplierStatus"), loading: busy, onAction: () => submit({ intent: "sync-suppliers" }) },
        { content: t("action.export"), onAction: () => downloadAuthed(`/app/orders/export?${params.toString()}`, "orders.csv") },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <JobProgress jobRunId={jobRunId} onDone={clearJobRun} />
            {errorText && (
              <Banner tone="critical">
                <p>{errorText}</p>
              </Banner>
            )}
            <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
              <Stat label={t("orders.list.stat.toSend")} value={String(data.counts.AWAITING_ORDER)} hint={t("orders.list.stat.toSendHint")} tone={data.counts.AWAITING_ORDER > 0 ? "default" : "subdued"} />
              <Stat label={t("orders.list.stat.toPay")} value={String(data.counts.AWAITING_PAYMENT)} hint={t("orders.list.stat.toPayHint")} tone={data.counts.AWAITING_PAYMENT > 0 ? "warning" : "subdued"} />
              <Stat label={t("orders.list.stat.inTransit")} value={String(data.counts.AWAITING_SHIPMENT + data.counts.AWAITING_DELIVERY)} hint={t("orders.list.stat.inTransitHint")} tone={data.counts.AWAITING_SHIPMENT + data.counts.AWAITING_DELIVERY > 0 ? "default" : "subdued"} />
              <Stat label={t("orders.list.stat.needsAttention")} value={String(needsAttention)} hint={t("orders.list.stat.needsAttentionHint")} tone={needsAttention > 0 ? "critical" : "subdued"} />
            </InlineGrid>
          </BlockStack>
        </Layout.Section>
        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={(i) => setParam("stage", tabs[i].id === "ALL" ? "" : tabs[i].id)} fitted />
            <Box padding="300">
              <Form onSubmit={() => setParam("q", search)}>
                <TextField
                  label={t("action.search")}
                  labelHidden
                  value={search}
                  onChange={setSearch}
                  autoComplete="off"
                  placeholder={t("orders.searchPlaceholder")}
                  clearButton
                  onClearButtonClick={() => {
                    setSearch("");
                    setParam("q", "");
                  }}
                  connectedRight={<Button submit>{t("action.search")}</Button>}
                />
              </Form>
            </Box>
            {items.length === 0 ? (
              filtered ? (
                <EmptyScreen
                  compact
                  heading={t("orders.list.empty.filteredHeading")}
                  body={t("orders.list.empty.filteredBody")}
                  action={data.search ? { content: t("orders.list.empty.clearSearch"), onAction: () => { setSearch(""); setParam("q", ""); } } : { content: t("common.viewAll"), url: "/app/orders" }}
                />
              ) : (
                <EmptyScreen compact heading={t("orders.empty.heading")} body={t("orders.empty.body")} action={{ content: t("orders.syncFromShopify"), onAction: () => submit({ intent: "sync", days: "30" }) }} />
              )
            ) : (
              <IndexTable
                resourceName={{ singular: t("orders.resource.singular"), plural: t("orders.resource.plural") }}
                itemCount={items.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                promotedBulkActions={[
                  {
                    content: placeable.length ? t("orders.list.action.sendSelected", { n: placeable.length }) : t("orders.list.action.sendToSupplier"),
                    disabled: placeable.length === 0,
                    onAction: () => setConfirmSend(true),
                  },
                ]}
                headings={[
                  { title: t("orders.column.order") },
                  { title: t("orders.list.column.customer") },
                  { title: t("orders.list.column.items"), alignment: "end" },
                  { title: t("common.total"), alignment: "end" },
                  { title: t("orders.list.column.supplierCost"), alignment: "end" },
                  { title: t("orders.list.column.profit"), alignment: "end" },
                  { title: t("orders.column.stage") },
                  { title: t("orders.column.supplierOrder") },
                  { title: t("orders.column.issues") },
                ]}
              >
                {items.map((o, index) => {
                  const errors = o.issues.filter((i) => i.severity === "error");
                  const warnings = o.issues.filter((i) => i.severity === "warning");
                  const profit = Number(o.total) - o.cost;
                  return (
                    <IndexTable.Row id={o.id} key={o.id} position={index} selected={selectedResources.includes(o.id)}>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Link to={`/app/orders/${o.id}`}>
                            <Text as="span" fontWeight="semibold">
                              {o.name}
                            </Text>
                          </Link>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {formatDate(o.createdAt)}
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span">{o.customer}</Text>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {o.country}
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end">
                          {String(o.items)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end">
                          {formatMoney(o.total, data.currency)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end" tone={o.cost > 0 ? undefined : "subdued"}>
                          {o.cost > 0 ? formatMoney(o.cost, data.currency) : "—"}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end" tone={o.cost > 0 ? (profit >= 0 ? "success" : "critical") : "subdued"}>
                          {o.cost > 0 ? formatMoney(profit, data.currency) : "—"}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <StatusBadge status={o.stage} />
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          {o.purchaseOrders.length === 0 && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              —
                            </Text>
                          )}
                          {o.purchaseOrders.map((po) => (
                            <InlineStack key={po.id} gap="100" blockAlign="center">
                              <StatusBadge status={po.status} />
                              <Text as="span" variant="bodySm">
                                {po.externalOrderId ?? t("orders.notPlaced")}
                              </Text>
                              {po.tracking.length > 0 && <Badge tone="success">{po.tracking[0]}</Badge>}
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="100" wrap>
                          {errors.length > 0 && (
                            <Tooltip content={errors.map((e) => e.message).join(" · ")}>
                              <Badge tone="critical">{`${errors.length} ${t("orders.blocking")}`}</Badge>
                            </Tooltip>
                          )}
                          {warnings.length > 0 && (
                            <Tooltip content={warnings.map((e) => e.message).join(" · ")}>
                              <Badge tone="warning">{`${warnings.length} ${t("orders.warnings")}`}</Badge>
                            </Tooltip>
                          )}
                          {o.managed === 0 && <Badge>{t("orders.notManaged")}</Badge>}
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
            <Box padding="300">
              <Paginator page={data.list.page} pageSize={data.list.pageSize} total={data.list.total} />
            </Box>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={confirmSend}
        onClose={() => setConfirmSend(false)}
        title={t("orders.list.confirmSend.title", { n: placeable.length })}
        primaryAction={{ content: t("orders.list.confirmSend.confirm"), onAction: sendSelected, loading: busy, disabled: placeable.length === 0 }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setConfirmSend(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">{t("orders.list.confirmSend.body")}</Text>
            {skipped > 0 && (
              <Text as="p" tone="subdued">
                {t("orders.list.confirmSend.skipped", { n: skipped })}
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
