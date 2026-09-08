import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useFetcher, useLoaderData } from "@remix-run/react";
import { Banner, BlockStack, Button, Card, DataTable, InlineGrid, InlineStack, Layout, Page, Select, Text } from "@shopify/polaris";
import { readForm, requireShop } from "~/lib/auth.server";
import { formatMoney, formatPercent } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
import { getReport, rollupRange } from "~/services/reports.server";

const RANGES: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };

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

export default function ReportsPage() {
  const t = useT();
  const { currency, range, report } = useLoaderData<typeof loader>();
  // A controlled Select with a no-op onChange snaps back to the URL value on
  // every change, so the range could never actually be changed.
  const [selectedRange, setSelectedRange] = useState(range);
  useEffect(() => setSelectedRange(range), [range]);
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const totals = report.totals;
  const max = Math.max(1, ...report.series.map((s) => Number(s.revenue)));

  return (
    <Page
      title={t("page.reports.title")}
      subtitle={t("page.reports.subtitle")}
      secondaryActions={[{ content: t("reports.recalculate"), onAction: () => fetcher.submit({ range }, { method: "post" }), loading: fetcher.state !== "idle" }]}
    >
      <Layout>
        <Layout.Section>
          {actionMessage && (
            <Banner tone="success">
              <p>{actionMessage}</p>
            </Banner>
          )}
          <Card>
            <Form method="get">
              <InlineStack gap="200" blockAlign="end">
                <Select
                  label={t("reports.range.label")}
                  name="range"
                  value={selectedRange}
                  onChange={setSelectedRange}
                  options={[
                    { label: t("reports.range.last7Days"), value: "7d" },
                    { label: t("reports.range.last30Days"), value: "30d" },
                    { label: t("reports.range.last90Days"), value: "90d" },
                    { label: t("reports.range.last12Months"), value: "365d" },
                  ]}
                />
                <Button submit>{t("reports.apply")}</Button>
              </InlineStack>
            </Form>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
            <Kpi label={t("common.revenue")} value={formatMoney(totals.revenue, currency)} />
            <Kpi
              label={t("reports.supplierCost")}
              value={formatMoney(Number(totals.productCost) + Number(totals.shippingCost), currency)}
              hint={`${formatMoney(totals.shippingCost, currency)} ${t("reports.kpi.shippingHint")}`}
            />
            <Kpi label={t("common.profit")} value={formatMoney(totals.profit, currency)} hint={`${formatPercent(totals.marginPercent)} ${t("reports.kpi.marginHint")}`} />
            <Kpi
              label={t("reports.kpi.orders")}
              value={String(totals.orders)}
              hint={`${totals.itemsSold} ${t("reports.kpi.items")} · ${totals.ordersFulfilled} ${t("reports.kpi.fulfilled")} · ${totals.ordersFailed} ${t("reports.kpi.failed")}`}
            />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("reports.dailyChart.title")}
              </Text>
              {report.series.length === 0 ? (
                <Text as="p" tone="subdued">
                  {t("reports.noData")}
                </Text>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <svg width="100%" height="200" viewBox={`0 0 ${Math.max(600, report.series.length * 28)} 200`} preserveAspectRatio="none" role="img" aria-label={t("reports.dailyChart.title")}>
                    {report.series.map((s, i) => {
                      const x = i * 28 + 4;
                      const revenueH = (Number(s.revenue) / max) * 170;
                      const profitH = (Math.max(0, Number(s.profit)) / max) * 170;
                      return (
                        <g key={s.day}>
                          <rect x={x} y={180 - revenueH} width={10} height={revenueH} fill="#8fb8f6" />
                          <rect x={x + 11} y={180 - profitH} width={10} height={profitH} fill="#3d8c5c" />
                          <title>{`${s.day}: ${t("common.revenue")} ${s.revenue}, ${t("common.profit")} ${s.profit}, ${s.orders} ${t("reports.kpi.orders")}`}</title>
                        </g>
                      );
                    })}
                    <line x1="0" y1="180" x2="100%" y2="180" stroke="#c9cccf" />
                  </svg>
                  <InlineStack gap="300">
                    <Text as="span" variant="bodySm">
                      <span style={{ display: "inline-block", width: 10, height: 10, background: "#8fb8f6", marginRight: 4 }} /> {t("common.revenue")}
                    </Text>
                    <Text as="span" variant="bodySm">
                      <span style={{ display: "inline-block", width: 10, height: 10, background: "#3d8c5c", marginRight: 4 }} /> {t("common.profit")}
                    </Text>
                  </InlineStack>
                </div>
              )}
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
                headings={[t("reports.table.day"), t("reports.kpi.orders"), t("common.revenue"), t("common.cost"), t("common.profit")]}
                rows={report.series.slice(-31).reverse().map((s) => [s.day, s.orders, formatMoney(s.revenue, currency), formatMoney(s.cost, currency), formatMoney(s.profit, currency)])}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("reports.topProducts")}
              </Text>
              {report.topProducts.length === 0 ? (
                <Text as="p" tone="subdued">
                  {t("reports.noSales")}
                </Text>
              ) : (
                <DataTable
                  columnContentTypes={["text", "numeric", "numeric"]}
                  headings={[t("reports.table.product"), t("reports.table.units"), t("common.revenue")]}
                  rows={report.topProducts.map((p) => [p.title, p.units, formatMoney(p.revenue, currency)])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("reports.destinations")}
              </Text>
              {report.byCountry.length === 0 ? (
                <Text as="p" tone="subdued">
                  {t("reports.noOrders")}
                </Text>
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

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
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
