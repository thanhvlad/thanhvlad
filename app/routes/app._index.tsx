import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Grid,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { StatusBadge } from "~/components/StatusBadge";
import { STAGE_ORDER } from "~/domain/orders/pipeline";
import { readForm, requireShop } from "~/lib/auth.server";
import { formatMoney, relativeTime } from "~/lib/format";
import { findOrCreateJobRun } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { listNotifications } from "~/services/notifications.server";
import { getDashboardStats } from "~/services/reports.server";
import { listSupplierAccounts } from "~/services/supplier-accounts.server";
import { listPricingRules } from "~/services/pricing.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const [stats, notifications, suppliers, rules] = await Promise.all([
    getDashboardStats(shop.id),
    listNotifications(shop.id, { limit: 6 }),
    listSupplierAccounts(shop.id),
    listPricingRules(shop.id),
  ]);
  const onboarding = {
    supplier: suppliers.length > 0,
    pricing: rules.length > 0,
    product: stats.products.total > 0,
    order: Object.values(stats.stages).some((n) => n > 0),
  };
  return { shop: { name: shop.name ?? shop.domain, currency: shop.currency }, stats, notifications, onboarding };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { intent } = await readForm(request);
  if (intent === "sync-orders") {
    const { job, reused } = await findOrCreateJobRun({ shopId: shop.id, type: "sync-orders", payload: { days: 30 } });
    if (!reused) {
      await enqueue("sync-orders", { shopId: shop.id, days: 30, jobRunId: job.id }, { dedupeKey: `sync-orders-${shop.id}` });
    }
    return { ok: true, jobRunId: job.id, message: reused ? "A sync is already running." : undefined };
  }
  if (intent === "sync-suppliers") {
    const { job, reused } = await findOrCreateJobRun({ shopId: shop.id, type: "sync-purchase-orders" });
    if (!reused) {
      await enqueue("sync-purchase-orders", { shopId: shop.id, jobRunId: job.id }, { dedupeKey: `sync-po-manual-${shop.id}` });
    }
    return { ok: true, jobRunId: job.id, message: reused ? "A supplier check is already running." : undefined };
  }
  return { ok: false };
};

export default function Dashboard() {
  const { shop, stats, notifications, onboarding } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const steps = [
    { done: onboarding.supplier, label: "Connect a supplier account", to: "/app/suppliers" },
    { done: onboarding.pricing, label: "Create a pricing rule", to: "/app/pricing" },
    { done: onboarding.product, label: "Import your first product", to: "/app/search" },
    { done: onboarding.order, label: "Sync orders from Shopify", to: "/app/orders" },
  ];
  const completed = steps.filter((s) => s.done).length;

  return (
    <Page
      title={`Welcome, ${shop.name}`}
      subtitle="Dropshipping automation for AliExpress, CJ and more."
      primaryAction={{ content: "Find products", url: "/app/search" }}
      secondaryActions={[
        { content: "Sync orders", onAction: () => fetcher.submit({ intent: "sync-orders" }, { method: "post" }), loading: fetcher.state !== "idle" },
        { content: "Check supplier orders", onAction: () => fetcher.submit({ intent: "sync-suppliers" }, { method: "post" }) },
      ]}
    >
      <Layout>
        {completed < steps.length && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Get started
                  </Text>
                  <Text as="span" tone="subdued">
                    {completed}/{steps.length} done
                  </Text>
                </InlineStack>
                <ProgressBar progress={(completed / steps.length) * 100} size="small" />
                <List type="number">
                  {steps.map((step) => (
                    <List.Item key={step.label}>
                      <InlineStack gap="200" blockAlign="center">
                        {step.done ? <Badge tone="success">Done</Badge> : <Badge>To do</Badge>}
                        <Link to={step.to}>{step.label}</Link>
                      </InlineStack>
                    </List.Item>
                  ))}
                </List>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <Stat label="Revenue (7 days)" value={formatMoney(stats.week.revenue, shop.currency)} />
            <Stat label="Profit (7 days)" value={formatMoney(stats.week.profit, shop.currency)} />
            <Stat label="Orders (7 days)" value={String(stats.week.orders)} />
            <Stat label="Managed products" value={`${stats.products.total}`} hint={`${stats.products.unmapped} unmapped`} />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Orders pipeline
              </Text>
              <Grid>
                {STAGE_ORDER.map((stage) => (
                  <Grid.Cell key={stage} columnSpan={{ xs: 3, sm: 3, md: 3, lg: 3, xl: 3 }}>
                    <Link to={`/app/orders?stage=${stage}`} style={{ textDecoration: "none" }}>
                      <Box padding="300" background="bg-surface-secondary" borderRadius="200">
                        <BlockStack gap="100">
                          <StatusBadge status={stage} />
                          <Text as="p" variant="headingLg">
                            {stats.stages[stage]}
                          </Text>
                        </BlockStack>
                      </Box>
                    </Link>
                  </Grid.Cell>
                ))}
              </Grid>
              {stats.recentFailures > 0 && (
                <Text as="p" tone="critical">
                  {stats.recentFailures} order(s) failed at the supplier. <Link to="/app/orders?stage=FAILED">Review them</Link>.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Needs attention
                </Text>
                <Link to="/app/notifications">View all</Link>
              </InlineStack>
              {notifications.length === 0 ? (
                <Text as="p" tone="subdued">
                  Nothing right now.
                </Text>
              ) : (
                <BlockStack gap="200">
                  {notifications.map((n) => (
                    <Box key={n.id} padding="200" background={n.readAt ? undefined : "bg-surface-secondary"} borderRadius="200">
                      <InlineStack align="space-between" blockAlign="start" gap="200">
                        <BlockStack gap="050">
                          <Text as="p" fontWeight={n.readAt ? "regular" : "semibold"}>
                            {n.link ? <Link to={n.link}>{n.title}</Link> : n.title}
                          </Text>
                          {n.body && (
                            <Text as="p" tone="subdued" variant="bodySm">
                              {n.body}
                            </Text>
                          )}
                        </BlockStack>
                        <Text as="span" tone="subdued" variant="bodySm">
                          {relativeTime(n.createdAt)}
                        </Text>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Quick actions
              </Text>
              <BlockStack gap="200">
                <Button url="/app/search">Find & import products</Button>
                <Button url="/app/import" disabled={stats.importCount === 0}>
                  {stats.importCount > 0 ? `Review import list (${stats.importCount})` : "Import list is empty"}
                </Button>
                <Button url="/app/orders?stage=AWAITING_ORDER" disabled={stats.stages.AWAITING_ORDER === 0}>
                  {stats.stages.AWAITING_ORDER > 0 ? `Place ${stats.stages.AWAITING_ORDER} ready order(s)` : "No orders ready"}
                </Button>
                <Button url="/app/inventory">Run auto-update</Button>
                <Button url="/app/reports">Open reports</Button>
              </BlockStack>
              {stats.activeJobs > 0 && (
                <Text as="p" tone="subdued">
                  {stats.activeJobs} background job(s) running.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" tone="subdued" variant="bodySm">
          {label}
        </Text>
        <Text as="p" variant="headingLg">
          {value}
        </Text>
        {hint && (
          <Text as="p" tone="subdued" variant="bodySm">
            {hint}
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}
