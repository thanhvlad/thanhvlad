import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Card, DataTable, InlineGrid, InlineStack, Layout, Page, Tabs, Text } from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { SectionHeader } from "~/components/SectionHeader";
import { Stat } from "~/components/Stat";
import { Thumb } from "~/components/Thumb";
import { readForm, requireShop } from "~/lib/auth.server";
import type { I18nKey } from "~/lib/i18n";
import { formatMoney, formatPercent } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
import { getReport, rollupRange } from "~/services/reports.server";

const RANGES: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };

/** The period tabs, in the order they sit on the screen. */
const RANGE_TABS: Array<{ id: string; label: I18nKey }> = [
  { id: "7d", label: "reports.range.last7Days" },
  { id: "30d", label: "reports.range.last30Days" },
  { id: "90d", label: "reports.range.last90Days" },
  { id: "365d", label: "reports.range.last12Months" },
];

/** The by-day table stops here; the figures above it still cover the whole range. */
const DAY_ROWS = 31;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "30d";
  const days = RANGES[range] ?? 30;
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const report = await getReport(shop.id, { from, to });
  return { currency: shop.currency, range, report };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { get } = await readForm(request);
  const days = RANGES[get("range")] ?? 30;
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const rolled = await rollupRange(shop.id, from, to);
  return { ok: true, messageKey: "msg.metricsRecalculated", messageVars: { n: rolled } };
};

/**
 * A top-products row only links when it still points at a product we manage.
 * The report keys a line by product id when the mapping exists and otherwise
 * by the Shopify gid or the line title, and only the first is a page.
 */
const PRODUCT_ID = /^c[a-z0-9]{20,}$/;

export default function ReportsPage() {
  const t = useT();
  const { currency, range, report } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const totals = report.totals;
  const profit = Number(totals.profit);

  const tabs = RANGE_TABS.map((tab) => ({ id: tab.id, content: t(tab.label) }));
  const selectedIndex = RANGE_TABS.findIndex((tab) => tab.id === range);
  // An unknown `?range=` is reported as 30 days by the loader, so the tab says so too.
  const selected = selectedIndex < 0 ? 1 : selectedIndex;
  const selectRange = (i: number) => {
    const sp = new URLSearchParams(params);
    sp.set("range", RANGE_TABS[i].id);
    navigate(`?${sp.toString()}`);
  };
  const recalculate = () => fetcher.submit({ range }, { method: "post" });

  const dayRows = report.series.slice(-DAY_ROWS).reverse();

  return (
    <Page title={t("page.reports.title")} subtitle={t("page.reports.subtitle")} primaryAction={{ content: t("reports.recalculate"), onAction: recalculate, loading: fetcher.state !== "idle" }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionMessage && (
              <Banner tone="success">
                <p>{actionMessage}</p>
              </Banner>
            )}

            <Card padding="0">
              <Tabs tabs={tabs} selected={selected} onSelect={selectRange} />
              <Box padding="400">
                <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                  <Stat plain label={t("common.revenue")} value={formatMoney(totals.revenue, currency)} hint={t("reports.stat.revenueHint", { orders: totals.orders, items: totals.itemsSold })} />
                  <Stat plain label={t("reports.supplierCost")} value={formatMoney(Number(totals.productCost) + Number(totals.shippingCost), currency)} hint={`${formatMoney(totals.shippingCost, currency)} ${t("reports.kpi.shippingHint")}`} />
                  <Stat
                    plain
                    label={t("common.profit")}
                    value={formatMoney(totals.profit, currency)}
                    hint={t("reports.stat.profitHint", { fulfilled: totals.ordersFulfilled, failed: totals.ordersFailed })}
                    tone={profit > 0 ? "success" : profit < 0 ? "critical" : "default"}
                  />
                  <Stat plain label={t("reports.stat.margin")} value={formatPercent(totals.marginPercent)} hint={t("reports.stat.marginHint")} tone={profit < 0 ? "critical" : "default"} />
                </InlineGrid>
              </Box>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          {report.series.length === 0 ? (
            <EmptyScreen heading={t("reports.empty.heading")} body={t("reports.noData")} action={{ content: t("reports.recalculate"), onAction: recalculate }} />
          ) : (
            <Card>
              <BlockStack gap="400">
                <SectionHeader title={t("reports.byDay.title")} count={report.series.length} />
                <Text as="h3" variant="headingSm" tone="subdued">
                  {t("reports.dailyChart.title")}
                </Text>
                <DailyChart series={report.series} currency={currency} />
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
                  headings={[t("reports.table.day"), t("reports.kpi.orders"), t("common.revenue"), t("reports.supplierCost"), t("common.profit")]}
                  rows={dayRows.map((s) => [s.day, s.orders, formatMoney(s.revenue, currency), formatMoney(s.cost, currency), formatMoney(s.profit, currency)])}
                />
                {report.series.length > DAY_ROWS && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    {t("reports.byDay.help", { n: DAY_ROWS })}
                  </Text>
                )}
              </BlockStack>
            </Card>
          )}
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <SectionHeader title={t("reports.topProducts")} count={report.topProducts.length} />
              {report.topProducts.length === 0 ? (
                <EmptyScreen compact heading={t("reports.topProducts.empty.heading")} body={t("reports.noSales")} />
              ) : (
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric"]}
                  headings={[t("reports.table.product"), t("reports.table.units"), t("common.revenue")]}
                  rows={report.topProducts.map((p) => [
                    <InlineStack key={p.id} gap="200" blockAlign="center" wrap={false}>
                      <Thumb src={p.image} alt={p.title} size="extraSmall" />
                      {PRODUCT_ID.test(p.id) ? (
                        <Link to={`/app/products/${p.id}`}>{p.title}</Link>
                      ) : (
                        <Text as="span">{p.title}</Text>
                      )}
                    </InlineStack>,
                    p.units,
                    formatMoney(p.revenue, currency),
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <SectionHeader title={t("reports.destinations")} count={report.byCountry.length} />
              {report.byCountry.length === 0 ? (
                <EmptyScreen compact heading={t("reports.destinations.empty.heading")} body={t("reports.noOrders")} />
              ) : (
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric"]}
                  headings={[t("reports.table.country"), t("reports.kpi.orders"), t("common.revenue")]}
                  rows={report.byCountry.map((c) => [c.countryCode, c.orders, formatMoney(c.revenue, currency)])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

/**
 * Revenue and profit per day as paired bars.
 *
 * Polaris ships no chart, and a charting library is not on the table, so this
 * is plain SVG coloured with Polaris's own tokens: the bars take the same fill
 * as the info and success badges that make up the legend, so light and dark
 * admin themes both stay coherent.
 */
function DailyChart({ series, currency }: { series: Array<{ day: string; revenue: string; profit: string; orders: number }>; currency: string }) {
  const t = useT();
  const max = Math.max(1, ...series.map((s) => Number(s.revenue)));
  const step = 28;
  const height = 200;
  const baseline = 180;
  const width = Math.max(600, series.length * step);
  return (
    <BlockStack gap="200">
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("reports.dailyChart.title")}>
        {series.map((s, i) => {
          const x = i * step + 4;
          const revenueH = (Number(s.revenue) / max) * (baseline - 10);
          const profitH = (Math.max(0, Number(s.profit)) / max) * (baseline - 10);
          return (
            <g key={s.day}>
              <rect x={x} y={baseline - revenueH} width={10} height={revenueH} fill="var(--p-color-bg-fill-info)" />
              <rect x={x + 11} y={baseline - profitH} width={10} height={profitH} fill="var(--p-color-bg-fill-success)" />
              <title>{`${s.day}: ${t("common.revenue")} ${formatMoney(s.revenue, currency)} · ${t("common.profit")} ${formatMoney(s.profit, currency)} · ${s.orders} ${t("reports.kpi.orders")}`}</title>
            </g>
          );
        })}
        <line x1="0" y1={baseline} x2={width} y2={baseline} stroke="var(--p-color-border)" />
      </svg>
      <InlineStack gap="200" blockAlign="center">
        <Badge tone="info">{t("common.revenue")}</Badge>
        <Badge tone="success">{t("common.profit")}</Badge>
        <Text as="span" tone="subdued" variant="bodySm">
          {t("reports.chart.help")}
        </Text>
      </InlineStack>
    </BlockStack>
  );
}
