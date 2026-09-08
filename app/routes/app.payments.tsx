import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
  Tooltip,
  useIndexResourceState,
} from "@shopify/polaris";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, formatMoney, relativeTime } from "~/lib/format";
import { checkPayments, getPaymentQueue, markPaidManually, undoManualPayment } from "~/services/payments.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const queue = await getPaymentQueue(shop.id);
  return { queue, currency: shop.currency };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, actor } = await requireShop(request);
  const { intent, get, getAll } = await readForm(request);
  const ids = getAll("ids").flatMap((v) => v.split(",")).filter(Boolean);
  try {
    switch (intent) {
      case "check": {
        const result = await checkPayments(shop, ids.length ? ids : undefined);
        return {
          ok: true,
          message:
            result.paid > 0
              ? `${result.paid} of ${result.checked} order(s) are now paid.`
              : `Checked ${result.checked} order(s); none are paid yet.`,
        };
      }
      case "mark-paid": {
        for (const id of ids) await markPaidManually(shop, id, actor);
        return { ok: true, message: `${ids.length} order(s) marked as paid.` };
      }
      case "undo-paid": {
        await undoManualPayment(shop, get("id"));
        return { ok: true, message: "Moved back to the payment queue." };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function PaymentsPage() {
  const { queue } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const [opened, setOpened] = useState<string[]>([]);
  const items = queue.items;
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(items);

  const submit = (intent: string, extra: Record<string, string> = {}) => {
    fetcher.submit({ intent, ids: selectedResources.join(","), ...extra }, { method: "post" });
  };

  /**
   * Pay opens one supplier tab per order. Browsers block a burst of popups, so
   * the tabs are opened in sequence and the ones that were opened are remembered
   * to help the merchant keep their place.
   */
  const openSelected = () => {
    const targets = items.filter((i) => selectedResources.includes(i.id) && i.paymentUrl);
    targets.slice(0, 10).forEach((item, index) => {
      setTimeout(() => window.open(item.paymentUrl!, "_blank", "noopener"), index * 350);
    });
    setOpened((prev) => [...new Set([...prev, ...targets.slice(0, 10).map((t) => t.id)])]);
  };

  return (
    <Page
      title="Payments"
      subtitle="Supplier orders are paid on the supplier's own site. Open them here, then confirm."
      primaryAction={{
        content: selectedResources.length ? `Pay ${selectedResources.length} on supplier site` : "Pay on supplier site",
        disabled: selectedResources.length === 0,
        onAction: openSelected,
      }}
      secondaryActions={[
        { content: "Check payment status", onAction: () => submit("check"), loading: fetcher.state !== "idle" },
        {
          content: "Mark selected as paid",
          disabled: selectedResources.length === 0,
          onAction: () => {
            submit("mark-paid");
            clearSelection();
          },
        },
      ]}
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
          {queue.overdue > 0 && (
            <Banner tone="critical" title={`${queue.overdue} order(s) are past their payment deadline`}>
              <p>AliExpress cancels unpaid orders after 24 hours. Check whether they still exist on the supplier site; if they were cancelled, retry them from the order page.</p>
            </Banner>
          )}
          {queue.expiringSoon > 0 && queue.overdue === 0 && (
            <Banner tone="warning" title={`${queue.expiringSoon} order(s) must be paid within 6 hours`} />
          )}
        </Layout.Section>

        {items.length > 0 && (
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
              {queue.totals.map((total) => (
                <Card key={total.currency}>
                  <BlockStack gap="100">
                    <Text as="p" tone="subdued" variant="bodySm">
                      Outstanding ({total.currency})
                    </Text>
                    <Text as="p" variant="headingLg">
                      {formatMoney(total.amount, total.currency)}
                    </Text>
                    <Text as="p" tone="subdued" variant="bodySm">
                      {total.count} order(s)
                    </Text>
                  </BlockStack>
                </Card>
              ))}
              {queue.byPlatform.map((p) => (
                <Card key={p.platform}>
                  <BlockStack gap="200">
                    <InlineStack gap="200" blockAlign="center">
                      <PlatformBadge platform={p.platform} />
                      <Text as="p" tone="subdued" variant="bodySm">
                        {p.count} unpaid
                      </Text>
                    </InlineStack>
                    {p.bulkUrl && (
                      <Button size="slim" url={p.bulkUrl} external>
                        Open unpaid list
                      </Button>
                    )}
                  </BlockStack>
                </Card>
              ))}
            </InlineGrid>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card padding="0">
            {items.length === 0 ? (
              <EmptyState heading="Nothing to pay" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png" action={{ content: "View orders", url: "/app/orders" }}>
                <p>Supplier orders waiting for payment show up here as soon as they are placed.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "payment", plural: "payments" }}
                itemCount={items.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[
                  { title: "Shopify order" },
                  { title: "Supplier order" },
                  { title: "Items" },
                  { title: "Shipping" },
                  { title: "Total" },
                  { title: "Deadline" },
                  { title: "" },
                ]}
              >
                {items.map((item, index) => {
                  const overdue = item.hoursLeft !== null && item.hoursLeft <= 0;
                  const soon = item.hoursLeft !== null && item.hoursLeft > 0 && item.hoursLeft <= 6;
                  return (
                    <IndexTable.Row id={item.id} key={item.id} position={index} selected={selectedResources.includes(item.id)}>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Link to={`/app/orders/${item.orderId}`}>
                            <Text as="span" fontWeight="semibold">
                              {item.orderName}
                            </Text>
                          </Link>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {item.customer ?? "—"} · {item.countryCode ?? "—"}
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <InlineStack gap="100" blockAlign="center">
                            <PlatformBadge platform={item.platform} />
                            <StatusBadge status={item.status} />
                          </InlineStack>
                          <Text as="span" variant="bodySm">
                            {item.externalOrderId ?? "not placed"}
                          </Text>
                          {item.supplierAccount && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              via {item.supplierAccount}
                            </Text>
                          )}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {formatMoney(item.itemsCost, item.currency)}
                        <Text as="span" tone="subdued" variant="bodySm">
                          {" "}
                          ({item.itemCount})
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{formatMoney(item.shippingCost, item.currency)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" fontWeight="semibold">
                          {formatMoney(item.totalCost, item.currency)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {item.paymentDueAt ? (
                          <Tooltip content={formatDate(item.paymentDueAt)}>
                            <Badge tone={overdue ? "critical" : soon ? "warning" : undefined}>
                              {overdue ? "Overdue" : `${Math.floor(item.hoursLeft ?? 0)}h left`}
                            </Badge>
                          </Tooltip>
                        ) : (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {item.placedAt ? relativeTime(item.placedAt) : "—"}
                          </Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="100">
                          {item.paymentUrl && (
                            <Button
                              size="slim"
                              variant={opened.includes(item.id) ? "secondary" : "primary"}
                              url={item.paymentUrl}
                              external
                              onClick={() => setOpened((p) => [...new Set([...p, item.id])])}
                            >
                              {opened.includes(item.id) ? "Opened" : "Pay"}
                            </Button>
                          )}
                          <Button size="slim" onClick={() => fetcher.submit({ intent: "mark-paid", ids: item.id }, { method: "post" })}>
                            Paid
                          </Button>
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                How payment works
              </Text>
              <Box>
                <Text as="p" tone="subdued">
                  AliExpress does not let an app charge your account, so the app places the order and then hands you a
                  direct link to pay it. Select the orders you want, click Pay, and each one opens on AliExpress in its own
                  tab, already on the right order. After paying, use Check payment status — the app reads the status back
                  from AliExpress and moves the order to Awaiting shipment on its own. Unpaid AliExpress orders are
                  cancelled after 24 hours, which is what the deadline column counts down to.
                </Text>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
