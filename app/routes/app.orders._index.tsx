import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, Banner, BlockStack, Button, Card, EmptyState, IndexTable, InlineStack, Layout, Page, Tabs, Text, TextField, Tooltip, useIndexResourceState } from "@shopify/polaris";
import type { OrderStage } from "@prisma/client";
import { JobProgress } from "~/components/JobProgress";
import { Paginator } from "~/components/Paginator";
import { StatusBadge } from "~/components/StatusBadge";
import { STAGE_ORDER } from "~/domain/orders/pipeline";
import type { OrderIssue } from "~/domain/orders/pipeline";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, formatMoney } from "~/lib/format";
import { createJobRun } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { countOrdersByStage, listOrders } from "~/services/orders.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const stage = (url.searchParams.get("stage") ?? "ALL") as OrderStage | "ALL";
  const search = url.searchParams.get("q") ?? "";
  const page = Number(url.searchParams.get("page") ?? 1);
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
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(data.search);
  const [jobRunId, setJobRunId] = useState<string | null>(null);
  const items = data.list.items;
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(items);

  const result = fetcher.data as { ok?: boolean; error?: string; jobRunId?: string } | undefined;
  if (result?.jobRunId && result.jobRunId !== jobRunId) {
    setJobRunId(result.jobRunId);
    clearSelection();
  }

  const tabs = [{ id: "ALL", content: `All (${Object.values(data.counts).reduce((a, b) => a + b, 0)})` }, ...STAGE_ORDER.map((s) => ({ id: s, content: `${label(s)} (${data.counts[s]})` }))];
  const selectedTab = Math.max(0, tabs.findIndex((t) => t.id === data.stage));
  const placeable = selectedResources.filter((id) => items.find((i) => i.id === id)?.stage === "AWAITING_ORDER");

  return (
    <Page
      title="Orders"
      primaryAction={{
        content: placeable.length ? `Place ${placeable.length} order(s)` : "Place orders",
        disabled: placeable.length === 0,
        loading: fetcher.state !== "idle",
        onAction: () => fetcher.submit({ intent: "place", ids: placeable.join(",") }, { method: "post" }),
      }}
      secondaryActions={[
        { content: "Sync from Shopify", onAction: () => fetcher.submit({ intent: "sync", days: "30" }, { method: "post" }) },
        { content: "Check supplier status", onAction: () => fetcher.submit({ intent: "sync-suppliers" }, { method: "post" }) },
        { content: "Export CSV", url: `/app/orders/export?${params.toString()}`, external: true },
      ]}
    >
      <Layout>
        <Layout.Section>
          <JobProgress jobRunId={jobRunId} onDone={() => setJobRunId(null)} />
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
              selected={selectedTab}
              onSelect={(i) => {
                const sp = new URLSearchParams(params);
                sp.set("stage", tabs[i].id);
                sp.delete("page");
                navigate(`?${sp.toString()}`);
              }}
              fitted
            />
            <div style={{ padding: "var(--p-space-300)" }}>
              <TextField
                label="Search"
                labelHidden
                value={search}
                onChange={setSearch}
                autoComplete="off"
                placeholder="Order number, customer, supplier order id or tracking number"
                clearButton
                onClearButtonClick={() => {
                  setSearch("");
                  const sp = new URLSearchParams(params);
                  sp.delete("q");
                  navigate(`?${sp.toString()}`);
                }}
                connectedRight={
                  <Button
                    onClick={() => {
                      const sp = new URLSearchParams(params);
                      if (search) sp.set("q", search);
                      else sp.delete("q");
                      sp.delete("page");
                      navigate(`?${sp.toString()}`);
                    }}
                  >
                    Search
                  </Button>
                }
              />
            </div>
            {items.length === 0 ? (
              <EmptyState heading="No orders here" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png" action={{ content: "Sync from Shopify", onAction: () => fetcher.submit({ intent: "sync", days: "30" }, { method: "post" }) }}>
                <p>New Shopify orders arrive automatically via webhooks. Use sync to pull history.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "order", plural: "orders" }}
                itemCount={items.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[{ title: "Order" }, { title: "Customer" }, { title: "Ship to" }, { title: "Total" }, { title: "Cost" }, { title: "Stage" }, { title: "Supplier order" }, { title: "Issues" }]}
              >
                {items.map((o, index) => {
                  const errors = o.issues.filter((i) => i.severity === "error");
                  const warnings = o.issues.filter((i) => i.severity === "warning");
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
                            {formatDate(o.createdAt)} · {o.items} item(s)
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{o.customer}</IndexTable.Cell>
                      <IndexTable.Cell>{o.country}</IndexTable.Cell>
                      <IndexTable.Cell>{formatMoney(o.total, data.currency)}</IndexTable.Cell>
                      <IndexTable.Cell>{o.cost > 0 ? formatMoney(o.cost, data.currency) : "—"}</IndexTable.Cell>
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
                            <InlineStack key={po.id} gap="100">
                              <StatusBadge status={po.status} />
                              <Text as="span" variant="bodySm">
                                {po.externalOrderId ?? "not placed"}
                              </Text>
                              {po.tracking.length > 0 && <Badge tone="success">{po.tracking[0]}</Badge>}
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {errors.length > 0 && (
                          <Tooltip content={errors.map((e) => e.message).join(" · ")}>
                            <Badge tone="critical">{`${errors.length} blocking`}</Badge>
                          </Tooltip>
                        )}
                        {warnings.length > 0 && (
                          <Tooltip content={warnings.map((e) => e.message).join(" · ")}>
                            <Badge tone="warning">{`${warnings.length} warning(s)`}</Badge>
                          </Tooltip>
                        )}
                        {o.managed === 0 && <Badge>Not managed</Badge>}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
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

function label(stage: OrderStage) {
  return stage.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
