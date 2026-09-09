import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import {
  ActionList,
  Badge,
  Banner,
  BlockStack,
  Box,
  Card,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { JobProgress } from "~/components/JobProgress";
import { SectionHeader } from "~/components/SectionHeader";
import { CountTile, Stat } from "~/components/Stat";
import { StatusBadge } from "~/components/StatusBadge";
import { STAGE_ORDER } from "~/domain/orders/pipeline";
import { readForm, requireShop } from "~/lib/auth.server";
import { formatMoney, formatPercent, relativeTime } from "~/lib/format";
import type { I18nKey } from "~/lib/i18n";
import { useJobRun } from "~/lib/use-job-run";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
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
    return { ok: true, jobRunId: job.id, message: reused ? "A sync is already running." : undefined, messageKey: reused ? "dashboard.sync.alreadyRunning" : undefined };
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
    return { ok: true, jobRunId: job.id, message: reused ? "A supplier check is already running." : undefined, messageKey: reused ? "dashboard.sync.supplierAlreadyRunning" : undefined };
  }
  return { ok: false };
};

/** The onboarding steps, in the order a new store should take them. */
const ONBOARDING_STEPS = [
  { key: "supplier", to: "/app/suppliers" },
  { key: "pricing", to: "/app/pricing" },
  { key: "shipping", to: "/app/shipping" },
  { key: "fulfillmentService", to: "/app/settings/fulfillment" },
  { key: "product", to: "/app/search" },
  { key: "order", to: "/app/orders" },
] as const;

/**
 * Only the severities that change what a merchant should do get a badge; an
 * "info" row is already distinguished by being unread.
 */
function severityBadge(severity: string, t: ReturnType<typeof useT>) {
  if (severity === "critical" || severity === "error") return <Badge tone="critical">{t("dashboard.attention.urgent")}</Badge>;
  if (severity === "warning") return <Badge tone="warning">{t("dashboard.attention.warning")}</Badge>;
  return null;
}

export default function Dashboard() {
  const { shop, stats, notifications, onboarding, plan, showWelcome } = useLoaderData<typeof loader>();
  // The two sync actions share one fetcher so only one job can be started at a
  // time; dismissing the welcome banner has its own so it never greys them out.
  const syncFetcher = useFetcher<typeof action>();
  const welcomeFetcher = useFetcher<typeof action>();
  const t = useT();

  const syncing = syncFetcher.state !== "idle";
  const syncMessage = useMessage(syncFetcher.data as Parameters<typeof useMessage>[0]);
  const syncError = useErrorMessage(syncFetcher.data as Parameters<typeof useErrorMessage>[0]);
  const { jobRunId, clearJobRun } = useJobRun(syncFetcher.data);
  const startSync = (intent: "sync-orders" | "sync-suppliers") => syncFetcher.submit({ intent }, { method: "post" });

  const steps = ONBOARDING_STEPS.map((step) => ({
    ...step,
    done: onboarding[step.key],
    label: t(`dashboard.onboarding.${step.key}` as I18nKey),
    hint: t(`dashboard.onboarding.${step.key}.hint` as I18nKey),
  }));
  const completed = steps.filter((s) => s.done).length;
  const nextStep = steps.find((s) => !s.done);

  const revenue = Number(stats.week.revenue);
  const profit = Number(stats.week.profit);
  const margin = revenue > 0 ? (profit / revenue) * 100 : null;
  const readyOrders = stats.stages.AWAITING_ORDER;

  return (
    <Page
      title={`${t("page.dashboard.title")}, ${shop.name}`}
      subtitle={t("dashboard.subtitle")}
      primaryAction={{ content: t("nav.search"), url: "/app/search" }}
      actionGroups={[
        {
          title: t("dashboard.actions.sync"),
          disabled: syncing,
          actions: [
            {
              content: t("dashboard.action.syncOrders"),
              helpText: t("dashboard.actions.syncOrders.hint"),
              disabled: syncing,
              onAction: () => startSync("sync-orders"),
            },
            {
              content: t("dashboard.action.checkSupplierOrders"),
              helpText: t("dashboard.actions.checkSupplierOrders.hint"),
              disabled: syncing,
              onAction: () => startSync("sync-suppliers"),
            },
          ],
        },
      ]}
    >
      <Layout>
        {(syncError || syncMessage || jobRunId) && (
          <Layout.Section>
            <BlockStack gap="300">
              {syncError && (
                <Banner tone="critical">
                  <p>{syncError}</p>
                </Banner>
              )}
              {syncMessage && (
                <Banner tone="info">
                  <p>{syncMessage}</p>
                </Banner>
              )}
              <JobProgress jobRunId={jobRunId} onDone={clearJobRun} />
            </BlockStack>
          </Layout.Section>
        )}

        {showWelcome && (
          <Layout.Section>
            <Banner
              title={t("dashboard.welcome.title")}
              tone="info"
              onDismiss={() => welcomeFetcher.submit({ intent: "dismiss-welcome" }, { method: "post" })}
            >
              <BlockStack gap="200">
                <Text as="p">{t("dashboard.welcome.body")}</Text>
                <InlineStack gap="400">
                  <Link to="/support" target="_blank" rel="noreferrer">
                    {t("dashboard.welcome.support")}
                  </Link>
                  <Link to="/app/settings/plan">{t("dashboard.welcome.plan")}</Link>
                </InlineStack>
              </BlockStack>
            </Banner>
          </Layout.Section>
        )}

        {completed < steps.length && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("dashboard.getStarted")} />
                <BlockStack gap="150">
                  <Text as="p" tone="subdued" variant="bodySm" numeric>
                    {t("dashboard.onboarding.progress", { done: completed, total: steps.length })}
                  </Text>
                  <ProgressBar progress={Math.round((completed / steps.length) * 100)} size="small" tone="primary" />
                </BlockStack>
                <BlockStack gap="0">
                  {steps.map((step, index) => (
                    <Box
                      key={step.key}
                      paddingBlock="300"
                      borderBlockEndWidth={index < steps.length - 1 ? "025" : undefined}
                      borderColor="border"
                    >
                      <InlineStack gap="300" blockAlign="start" wrap={false}>
                        <Box minWidth="116px">
                          {step.done ? (
                            <Badge tone="success">{t("common.done")}</Badge>
                          ) : step === nextStep ? (
                            <Badge tone="attention">{t("dashboard.onboarding.next")}</Badge>
                          ) : (
                            <Badge>{t("common.toDo")}</Badge>
                          )}
                        </Box>
                        <BlockStack gap="050">
                          <Text as="p" fontWeight={step.done ? "regular" : "semibold"} tone={step.done ? "subdued" : "base"}>
                            {step.done ? step.label : <Link to={step.to}>{step.label}</Link>}
                          </Text>
                          <Text as="p" tone="subdued" variant="bodySm">
                            {step.hint}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <Stat label={t("dashboard.stat.revenue7d")} value={formatMoney(stats.week.revenue, shop.currency)} />
            <Stat
              label={t("dashboard.stat.profit7d")}
              value={formatMoney(stats.week.profit, shop.currency)}
              hint={margin === null ? undefined : t("dashboard.stat.margin", { percent: formatPercent(margin) })}
              tone={profit < 0 ? "critical" : "default"}
            />
            <Stat
              label={t("dashboard.stat.orders7d")}
              value={String(stats.week.orders)}
            />
            <Stat
              label={t("dashboard.stat.managedProducts")}
              value={String(stats.products.total)}
              hint={
                stats.products.unmapped > 0
                  ? t("dashboard.stat.unmappedHint", { n: stats.products.unmapped })
                  : stats.products.total > 0
                    ? t("dashboard.stat.allMapped")
                    : undefined
              }
            />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <SectionHeader title={t("dashboard.ordersPipeline")} action={{ content: t("common.viewAll"), to: "/app/orders" }} />
              <InlineGrid columns={{ xs: 2, sm: 3, md: 4, lg: 4 }} gap="300">
                {STAGE_ORDER.map((stage) => (
                  <Link key={stage} to={`/app/orders?stage=${stage}`} style={{ textDecoration: "none" }}>
                    <CountTile label={t(`stage.${stage}` as I18nKey)} count={stats.stages[stage]}>
                      <StatusBadge status={stage} />
                    </CountTile>
                  </Link>
                ))}
              </InlineGrid>
              {stats.recentFailures > 0 && (
                <Text as="p" tone="critical">
                  {t("dashboard.pipeline.failed", { n: stats.recentFailures })}{" "}
                  <Link to="/app/orders?stage=FAILED">{t("dashboard.reviewThem")}</Link>
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <SectionHeader
                title={t("common.needsAttention")}
                count={stats.unread > 0 ? stats.unread : undefined}
                action={{ content: t("common.viewAll"), to: "/app/notifications" }}
              />
              {notifications.length === 0 ? (
                <EmptyScreen compact heading={t("notifications.empty")} body={t("notifications.emptyBody")} />
              ) : (
                <BlockStack gap="0">
                  {notifications.map((n, index) => (
                    <Box
                      key={n.id}
                      paddingBlock="200"
                      paddingInline={n.readAt ? undefined : "200"}
                      background={n.readAt ? undefined : "bg-surface-secondary"}
                      borderRadius={n.readAt ? undefined : "200"}
                      borderBlockEndWidth={index < notifications.length - 1 ? "025" : undefined}
                      borderColor="border"
                    >
                      <InlineStack align="space-between" blockAlign="start" gap="300" wrap={false}>
                        <BlockStack gap="050">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="p" fontWeight={n.readAt ? "regular" : "semibold"}>
                              {n.link ? <Link to={n.link}>{n.title}</Link> : n.title}
                            </Text>
                            {severityBadge(n.severity, t)}
                          </InlineStack>
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
              <SectionHeader title={t("dashboard.quickActions")} />
              <ActionList
                items={[
                  {
                    content: t("dashboard.quick.findImport"),
                    helpText: t("dashboard.quick.findImport.hint"),
                    url: "/app/search",
                  },
                  {
                    content: t("dashboard.quick.reviewImportList"),
                    helpText: stats.importCount > 0 ? t("dashboard.quick.reviewImportList.hint") : t("dashboard.quick.importListEmpty"),
                    suffix: stats.importCount > 0 ? <Badge>{String(stats.importCount)}</Badge> : undefined,
                    url: "/app/import",
                    disabled: stats.importCount === 0,
                  },
                  {
                    content: t("dashboard.quick.placeReady"),
                    helpText: readyOrders > 0 ? t("dashboard.quick.placeReady.hint") : t("dashboard.quick.noOrdersReady"),
                    suffix: readyOrders > 0 ? <Badge tone="info">{String(readyOrders)}</Badge> : undefined,
                    url: "/app/orders?stage=AWAITING_ORDER",
                    disabled: readyOrders === 0,
                  },
                  {
                    content: t("dashboard.quick.runAutoUpdate"),
                    helpText: t("dashboard.quick.runAutoUpdate.hint"),
                    url: "/app/inventory",
                  },
                  {
                    content: t("dashboard.quick.openReports"),
                    helpText: t("dashboard.quick.openReports.hint"),
                    url: "/app/reports",
                  },
                ]}
              />
              {stats.activeJobs > 0 && (
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("dashboard.jobsRunning", { n: stats.activeJobs })} · <Link to="/app/logs">{t("nav.logs")}</Link>
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
              <InlineStack gap="300" blockAlign="baseline">
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("dashboard.stat.plan")}
                </Text>
                <Text as="p" variant="headingSm">
                  {plan.name}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm" numeric>
                  {t("dashboard.stat.planUsage", { used: plan.productsUsed, limit: plan.productsLimit ?? t("plan.unlimited") })}
                </Text>
              </InlineStack>
              <Link to="/app/settings/plan">{t("dashboard.plan.manage")}</Link>
            </InlineStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
