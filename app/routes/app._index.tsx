import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
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
import { useT } from "~/lib/use-t";
import { findOrCreateJobRun } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { listNotifications } from "~/services/notifications.server";
import { getDashboardStats } from "~/services/reports.server";
import { listSupplierAccounts } from "~/services/supplier-accounts.server";
import { listPricingRules } from "~/services/pricing.server";
import { PLANS } from "~/domain/billing/plans";
import { mergeShopSettings } from "~/domain/settings/shop-settings";
import { getAccountBilling } from "~/services/billing.server";
import { listShippingPreferences } from "~/services/shipping.server";
import { updateShopSettings } from "~/services/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const [stats, notifications, suppliers, rules, billing, shipping] = await Promise.all([
    getDashboardStats(shop.id),
    listNotifications(shop.id, { limit: 6 }),
    listSupplierAccounts(shop.id),
    listPricingRules(shop.id),
    getAccountBilling(shop),
    listShippingPreferences(shop.id),
  ]);
  const plan = {
    name: PLANS[billing.plan].displayName,
    productsUsed: billing.usage.products,
    productsLimit: PLANS[billing.plan].limits.products,
  };
  const onboarding = {
    supplier: suppliers.length > 0,
    pricing: rules.length > 0,
    shipping: shipping.length > 0,
    fulfillmentService: Boolean(shop.fulfillmentServiceId),
    product: stats.products.total > 0,
    order: Object.values(stats.stages).some((n) => n > 0),
  };
  const showWelcome = !shop.parsedSettings.ui.dismissedTips.includes("welcome");
  return { shop: { name: shop.name ?? shop.domain, currency: shop.currency }, stats, notifications, onboarding, plan, showWelcome };
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
  if (intent === "dismiss-welcome") {
    const tips = shop.parsedSettings.ui.dismissedTips;
    if (!tips.includes("welcome")) {
      await updateShopSettings(shop.id, mergeShopSettings(shop.settings, { ui: { dismissedTips: [...tips, "welcome"] } }));
    }
    return { ok: true };
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
  const { shop, stats, notifications, onboarding, plan, showWelcome } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const t = useT();
  const steps = [
    { done: onboarding.supplier, label: t("dashboard.onboarding.supplier"), to: "/app/suppliers" },
    { done: onboarding.pricing, label: t("dashboard.onboarding.pricing"), to: "/app/pricing" },
    { done: onboarding.shipping, label: t("dashboard.onboarding.shipping"), to: "/app/shipping" },
    { done: onboarding.fulfillmentService, label: t("dashboard.onboarding.fulfillmentService"), to: "/app/settings/fulfillment" },
    { done: onboarding.product, label: t("dashboard.onboarding.product"), to: "/app/search" },
    { done: onboarding.order, label: t("dashboard.onboarding.order"), to: "/app/orders" },
  ];
  const completed = steps.filter((s) => s.done).length;

  return (
    <Page
      title={`${t("page.dashboard.title")}, ${shop.name}`}
      subtitle={t("page.dashboard.subtitle")}
      primaryAction={{ content: t("nav.search"), url: "/app/search" }}
      secondaryActions={[
        { content: t("dashboard.action.syncOrders"), onAction: () => fetcher.submit({ intent: "sync-orders" }, { method: "post" }), loading: fetcher.state !== "idle" },
        { content: t("dashboard.action.checkSupplierOrders"), onAction: () => fetcher.submit({ intent: "sync-suppliers" }, { method: "post" }) },
      ]}
    >
      <Layout>
        {showWelcome && (
          <Layout.Section>
            <Banner title={t("dashboard.welcome.title")} tone="info" onDismiss={() => fetcher.submit({ intent: "dismiss-welcome" }, { method: "post" })}>
              <BlockStack gap="200">
                <Text as="p">{t("dashboard.welcome.body")}</Text>
                <InlineStack gap="200">
                  <Button url="/support" target="_blank" variant="plain">
                    {t("dashboard.welcome.support")}
                  </Button>
                  <Button url="/app/settings/plan" variant="plain">
                    {t("dashboard.welcome.plan")}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}
        {completed < steps.length && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {t("dashboard.getStarted")}
                  </Text>
                  <Text as="span" tone="subdued">
                    {completed}/{steps.length} {t("dashboard.stepsDone")}
                  </Text>
                </InlineStack>
                <ProgressBar progress={(completed / steps.length) * 100} size="small" />
                <List type="number">
                  {steps.map((step) => (
                    <List.Item key={step.label}>
                      <InlineStack gap="200" blockAlign="center">
                        {step.done ? <Badge tone="success">{t("common.done")}</Badge> : <Badge>{t("common.toDo")}</Badge>}
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
            <Stat label={t("dashboard.stat.revenue7d")} value={formatMoney(stats.week.revenue, shop.currency)} />
            <Stat label={t("dashboard.stat.profit7d")} value={formatMoney(stats.week.profit, shop.currency)} />
            <Stat label={t("dashboard.stat.orders7d")} value={String(stats.week.orders)} />
            <Stat
              label={t("dashboard.stat.managedProducts")}
              value={`${stats.products.total}`}
              hint={`${stats.products.unmapped} ${t("dashboard.stat.unmapped")}`}
            />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <InlineStack align="space-between" blockAlign="center" wrap>
              <BlockStack gap="050">
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("dashboard.stat.plan")}
                </Text>
                <Text as="p" variant="headingMd">
                  {plan.name}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("dashboard.stat.planUsage", { used: plan.productsUsed, limit: plan.productsLimit ?? t("plan.unlimited") })}
                </Text>
              </BlockStack>
              <Button url="/app/settings/plan">{t("settings.tabs.plan")}</Button>
            </InlineStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("dashboard.ordersPipeline")}
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
                  {stats.recentFailures} {t("dashboard.ordersFailedAtSupplier")}{" "}
                  <Link to="/app/orders?stage=FAILED">{t("dashboard.reviewThem")}</Link>.
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
                  {t("common.needsAttention")}
                </Text>
                <Link to="/app/notifications">{t("common.viewAll")}</Link>
              </InlineStack>
              {notifications.length === 0 ? (
                <Text as="p" tone="subdued">
                  {t("dashboard.nothingRightNow")}
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
                {t("dashboard.quickActions")}
              </Text>
              <BlockStack gap="200">
                <Button url="/app/search">{t("dashboard.quick.findImport")}</Button>
                <Button url="/app/import" disabled={stats.importCount === 0}>
                  {stats.importCount > 0
                    ? `${t("dashboard.quick.reviewImportList")} (${stats.importCount})`
                    : t("dashboard.quick.importListEmpty")}
                </Button>
                <Button url="/app/orders?stage=AWAITING_ORDER" disabled={stats.stages.AWAITING_ORDER === 0}>
                  {stats.stages.AWAITING_ORDER > 0
                    ? `${t("dashboard.quick.place")} ${stats.stages.AWAITING_ORDER} ${t("dashboard.quick.readyOrders")}`
                    : t("dashboard.quick.noOrdersReady")}
                </Button>
                <Button url="/app/inventory">{t("dashboard.quick.runAutoUpdate")}</Button>
                <Button url="/app/reports">{t("dashboard.quick.openReports")}</Button>
              </BlockStack>
              {stats.activeJobs > 0 && (
                <Text as="p" tone="subdued">
                  {stats.activeJobs} {t("dashboard.backgroundJobsRunning")}
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
