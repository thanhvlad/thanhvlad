import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useFetcher, useLoaderData } from "@remix-run/react";
import { Banner, BlockStack, Button, Card, DataTable, InlineGrid, InlineStack, Layout, Page, Select, Text } from "@shopify/polaris";
import { readForm, requireShop } from "~/lib/auth.server";
import { formatMoney, formatPercent } from "~/lib/format";
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
  return { ok: true, message: `Recalculated ${rolled} day(s).` };
};

export default function ReportsPage() {
  const { currency, range, report } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string } | undefined;
  const totals = report.totals;
  const max = Math.max(1, ...report.series.map((s) => Number(s.revenue)));

  return (
    <Page
      title="Reports"
      subtitle="Revenue, supplier cost and profit for orders managed by the app."
      secondaryActions={[{ content: "Recalculate", onAction: () => fetcher.submit({ range }, { method: "post" }), loading: fetcher.state !== "idle" }]}
    >
      <Layout>
        <Layout.Section>
          {result?.message && (
            <Banner tone="success">
              <p>{result.message}</p>
            </Banner>
          )}
          <Card>
            <Form method="get">
              <InlineStack gap="200" blockAlign="end">
                <Select label="Range" name="range" value={range} onChange={() => undefined} options={[{ label: "Last 7 days", value: "7d" }, { label: "Last 30 days", value: "30d" }, { label: "Last 90 days", value: "90d" }, { label: "Last 12 months", value: "365d" }]} />
                <Button submit>Apply</Button>
              </InlineStack>
            </Form>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
            <Kpi label="Revenue" value={formatMoney(totals.revenue, currency)} />
            <Kpi label="Supplier cost" value={formatMoney(Number(totals.productCost) + Number(totals.shippingCost), currency)} hint={`${formatMoney(totals.shippingCost, currency)} shipping`} />
            <Kpi label="Profit" value={formatMoney(totals.profit, currency)} hint={`${formatPercent(totals.marginPercent)} margin`} />
            <Kpi label="Orders" value={String(totals.orders)} hint={`${totals.itemsSold} items · ${totals.ordersFulfilled} fulfilled · ${totals.ordersFailed} failed`} />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Daily revenue and profit
              </Text>
              {report.series.length === 0 ? (
                <Text as="p" tone="subdued">
                  No data for this range yet. Orders are aggregated hourly; use Recalculate to refresh now.
                </Text>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <svg width="100%" height="200" viewBox={`0 0 ${Math.max(600, report.series.length * 28)} 200`} preserveAspectRatio="none" role="img" aria-label="Daily revenue and profit">
                    {report.series.map((s, i) => {
                      const x = i * 28 + 4;
                      const revenueH = (Number(s.revenue) / max) * 170;
                      const profitH = (Math.max(0, Number(s.profit)) / max) * 170;
                      return (
                        <g key={s.day}>
                          <rect x={x} y={180 - revenueH} width={10} height={revenueH} fill="#8fb8f6" />
                          <rect x={x + 11} y={180 - profitH} width={10} height={profitH} fill="#3d8c5c" />
                          <title>{`${s.day}: revenue ${s.revenue}, profit ${s.profit}, ${s.orders} orders`}</title>
                        </g>
                      );
                    })}
                    <line x1="0" y1="180" x2="100%" y2="180" stroke="#c9cccf" />
                  </svg>
                  <InlineStack gap="300">
                    <Text as="span" variant="bodySm">
                      <span style={{ display: "inline-block", width: 10, height: 10, background: "#8fb8f6", marginRight: 4 }} /> Revenue
                    </Text>
                    <Text as="span" variant="bodySm">
                      <span style={{ display: "inline-block", width: 10, height: 10, background: "#3d8c5c", marginRight: 4 }} /> Profit
                    </Text>
                  </InlineStack>
                </div>
              )}
              <DataTable
                columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric"]}
                headings={["Day", "Orders", "Revenue", "Cost", "Profit"]}
                rows={report.series.slice(-31).reverse().map((s) => [s.day, s.orders, formatMoney(s.revenue, currency), formatMoney(s.cost, currency), formatMoney(s.profit, currency)])}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Top products
              </Text>
              {report.topProducts.length === 0 ? (
                <Text as="p" tone="subdued">
                  No sales yet.
                </Text>
              ) : (
                <DataTable columnContentTypes={["text", "numeric", "numeric"]} headings={["Product", "Units", "Revenue"]} rows={report.topProducts.map((p) => [p.title, p.units, formatMoney(p.revenue, currency)])} />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Destinations
              </Text>
              {report.byCountry.length === 0 ? (
                <Text as="p" tone="subdued">
                  No orders yet.
                </Text>
              ) : (
                <DataTable columnContentTypes={["text", "numeric", "numeric"]} headings={["Country", "Orders", "Revenue"]} rows={report.byCountry.map((c) => [c.countryCode, c.orders, formatMoney(c.revenue, currency)])} />
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
