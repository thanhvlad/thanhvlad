import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import type { PurchaseOrderStatus, SupplierPlatform } from "@prisma/client";
import { Badge, Banner, BlockStack, Button, Card, IndexTable, InlineGrid, InlineStack, Layout, Page, Tabs, Text, Tooltip, useIndexResourceState } from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { SectionHeader } from "~/components/SectionHeader";
import { Stat } from "~/components/Stat";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, formatMoney, relativeTime } from "~/lib/format";
import type { I18nVars } from "~/lib/i18n";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
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
        // `message` is kept for anything that reads it; the key is what lets a
        // Vietnamese merchant read the outcome in their own language.
        return {
          ok: true,
          message:
            result.paid > 0
              ? `${result.paid} of ${result.checked} order(s) are now paid.`
              : `Checked ${result.checked} order(s); none are paid yet.`,
          messageKey: result.paid > 0 ? "payments.msg.checkedPaid" : "payments.msg.checkedNone",
          messageVars: { paid: result.paid, checked: result.checked },
        };
      }
      case "mark-paid": {
        for (const id of ids) await markPaidManually(shop, id, actor);
        return { ok: true, messageKey: "msg.ordersMarkedPaid", messageVars: { n: ids.length } };
      }
      case "undo-paid": {
        await undoManualPayment(shop, get("id"));
        return { ok: true, messageKey: "msg.backToPaymentQueue" };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

type ActionResult = { ok?: boolean; message?: string; messageKey?: string; messageVars?: I18nVars; error?: string };

/**
 * The queue only ever holds the two "placed upstream, not paid" statuses
 * (`UNPAID_STATUSES` in the payments service, which cannot be imported into a
 * client component), plus the deadline-derived Overdue view.
 */
const TABS = ["all", "AWAITING_PAYMENT", "PLACED", "overdue"] as const;
type TabId = (typeof TABS)[number];

/** Supplier platform as the merchant names it; PlatformBadge keeps the same wording. */
function platformName(platform: SupplierPlatform): string {
  return platform === "ALIEXPRESS" ? "AliExpress" : platform === "CJ_DROPSHIPPING" ? "CJ" : platform === "MOCK" ? "Mock" : platform;
}

export default function PaymentsPage() {
  const t = useT();
  const { queue } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const result = fetcher.data as ActionResult | undefined;
  const actionMessage = useMessage(result);
  const actionError = useErrorMessage(result);
  const [opened, setOpened] = useState<string[]>([]);

  const busy = fetcher.state !== "idle";
  const pendingIntent = busy ? fetcher.formData?.get("intent") : null;
  const pendingIds = busy ? String(fetcher.formData?.get("ids") ?? "") : "";

  const tabParam = params.get("status") as TabId | null;
  const tab: TabId = tabParam && TABS.includes(tabParam) ? tabParam : "all";
  const isOverdue = (hoursLeft: number | null) => hoursLeft !== null && hoursLeft <= 0;
  const matches = (item: (typeof queue.items)[number], id: TabId) =>
    id === "all" ? true : id === "overdue" ? isOverdue(item.hoursLeft) : item.status === (id as PurchaseOrderStatus);
  const items = queue.items.filter((item) => matches(item, tab));

  const tabs = TABS.map((id) => {
    const label = id === "all" ? t("common.all") : id === "overdue" ? t("payments.tab.overdue") : id === "AWAITING_PAYMENT" ? t("stage.AWAITING_PAYMENT") : t("status.PLACED");
    return { id, content: `${label} (${queue.items.filter((item) => matches(item, id)).length})` };
  });
  const selectedTab = Math.max(0, tabs.findIndex((entry) => entry.id === tab));

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(items);

  const submit = (intent: string, ids: string[]) => {
    fetcher.submit({ intent, ids: ids.join(",") }, { method: "post" });
  };

  const selectTab = (index: number) => {
    const sp = new URLSearchParams(params);
    if (tabs[index].id === "all") sp.delete("status");
    else sp.set("status", tabs[index].id);
    clearSelection();
    navigate(`?${sp.toString()}`);
  };

  /**
   * Pay opens one supplier tab per order. Browsers block a burst of popups, so
   * the tabs are opened in sequence and the ones that were opened are remembered
   * to help the merchant keep their place.
   */
  const openSelected = () => {
    const targets = items.filter((i) => selectedResources.includes(i.id) && i.paymentUrl).slice(0, 10);
    targets.forEach((item, index) => {
      setTimeout(() => window.open(item.paymentUrl!, "_blank", "noopener"), index * 350);
    });
    setOpened((prev) => [...new Set([...prev, ...targets.map((target) => target.id)])]);
  };

  // ---- Stat strip: everything here comes from the queue the loader already built.
  const oldest = queue.items.reduce<(typeof queue.items)[number] | null>((best, item) => {
    const when = item.placedAt ?? item.orderCreatedAt;
    if (!when) return best;
    const bestWhen = best ? (best.placedAt ?? best.orderCreatedAt) : null;
    return !bestWhen || new Date(when) < new Date(bestWhen) ? item : best;
  }, null);
  const hasDeadlines = queue.items.some((item) => item.hoursLeft !== null);

  const bannerTone = result?.messageKey === "payments.msg.checkedNone" ? "info" : "success";

  const payLabel = selectedResources.length ? `${t("action.pay")} (${selectedResources.length})` : t("action.pay");

  return (
    <Page
      fullWidth
      title={t("page.payments.title")}
      subtitle={t("page.payments.subtitle")}
      primaryAction={{ content: payLabel, disabled: selectedResources.length === 0, onAction: openSelected }}
      secondaryActions={[
        {
          content: t("action.checkPayment"),
          onAction: () => submit("check", []),
          loading: pendingIntent === "check" && pendingIds === "",
          disabled: busy || queue.items.length === 0,
        },
        ...queue.byPlatform
          .filter((p) => p.bulkUrl)
          .map((p) => ({ content: t("payments.openUnpaidListOn", { platform: platformName(p.platform) }), url: p.bulkUrl!, external: true })),
      ]}
    >
      <Layout>
        {(actionMessage || actionError || queue.overdue > 0 || queue.expiringSoon > 0) && (
          <Layout.Section>
            <BlockStack gap="300">
              {actionMessage && (
                <Banner tone={bannerTone}>
                  <p>{actionMessage}</p>
                </Banner>
              )}
              {actionError && (
                <Banner tone="critical">
                  <p>{actionError}</p>
                </Banner>
              )}
              {queue.overdue > 0 && (
                <Banner tone="critical" title={t("payments.banner.overdue", { n: queue.overdue })}>
                  <p>
                    {t("payments.autoCancelWarning")} {t("payments.overdueBannerBody")}
                  </p>
                </Banner>
              )}
              {queue.expiringSoon > 0 && queue.overdue === 0 && (
                <Banner tone="warning" title={t("payments.banner.dueSoon", { n: queue.expiringSoon })}>
                  <p>{t("payments.autoCancelWarning")}</p>
                </Banner>
              )}
            </BlockStack>
          </Layout.Section>
        )}

        {queue.items.length > 0 && (
          <Layout.Section>
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
              {queue.totals.slice(0, 1).map((total) => (
                <Stat
                  key={total.currency}
                  label={t("payments.stat.unpaidTotal", { currency: total.currency })}
                  value={formatMoney(total.amount, total.currency)}
                  hint={queue.totals.length > 1 ? queue.totals.slice(1).map((extra) => formatMoney(extra.amount, extra.currency)).join(" · ") : t("payments.stat.orders", { n: total.count })}
                />
              ))}
              <Stat
                label={t("payments.stat.unpaidOrders")}
                value={String(queue.items.length)}
                hint={queue.expiringSoon > 0 ? t("payments.stat.dueSoon", { n: queue.expiringSoon }) : t("payments.stat.noneDueSoon")}
                tone={queue.expiringSoon > 0 ? "warning" : "default"}
              />
              <Stat
                label={t("payments.stat.oldest")}
                value={oldest ? relativeTime(oldest.placedAt ?? oldest.orderCreatedAt) : "—"}
                hint={oldest ? `${oldest.orderName} · ${formatDate(oldest.placedAt ?? oldest.orderCreatedAt)}` : undefined}
              />
              <Stat
                label={t("payments.stat.overdue")}
                value={String(queue.overdue)}
                hint={queue.overdue > 0 ? t("payments.autoCancelWarning") : hasDeadlines ? t("payments.stat.noOverdue") : t("payments.stat.noDeadline")}
                tone={queue.overdue > 0 ? "critical" : queue.overdue === 0 && hasDeadlines ? "success" : "subdued"}
              />
            </InlineGrid>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={selectTab} />
            {queue.items.length === 0 ? (
              <EmptyScreen heading={t("payments.empty")} body={t("payments.emptyBody")} action={{ content: t("payments.viewOrders"), url: "/app/orders" }} />
            ) : items.length === 0 ? (
              <EmptyScreen heading={t("payments.emptyTab")} body={t("payments.emptyTabBody")} action={{ content: t("payments.viewAllUnpaid"), onAction: () => selectTab(0) }} />
            ) : (
              <IndexTable
                resourceName={{ singular: t("payments.resourceSingular"), plural: t("payments.resourcePlural") }}
                itemCount={items.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                promotedBulkActions={[
                  { content: t("payments.paySelected"), onAction: openSelected, disabled: !items.some((i) => selectedResources.includes(i.id) && i.paymentUrl) },
                  { content: t("payments.checkSelected"), onAction: () => submit("check", selectedResources), disabled: busy },
                  {
                    content: t("payments.markSelectedPaid"),
                    disabled: busy,
                    onAction: () => {
                      submit("mark-paid", selectedResources);
                      clearSelection();
                    },
                  },
                ]}
                headings={[
                  { title: t("payments.col.order") },
                  { title: t("common.supplier") },
                  { title: t("payments.col.items"), alignment: "end" },
                  { title: t("common.shipping"), alignment: "end" },
                  { title: t("common.total"), alignment: "end" },
                  { title: t("common.status") },
                  { title: t("payments.deadline") },
                  { title: t("payments.col.placed") },
                  { title: t("payments.col.actions") },
                ]}
              >
                {items.map((item, index) => {
                  const overdue = isOverdue(item.hoursLeft);
                  const soon = item.hoursLeft !== null && item.hoursLeft > 0 && item.hoursLeft <= 6;
                  const wasOpened = opened.includes(item.id);
                  const markingThisRow = pendingIntent === "mark-paid" && pendingIds === item.id;
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
                            <Text as="span" variant="bodySm">
                              {item.externalOrderId ?? t("payments.notPlaced")}
                            </Text>
                          </InlineStack>
                          {item.supplierAccount && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              {t("payments.via")} {item.supplierAccount}
                            </Text>
                          )}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050" inlineAlign="end">
                          <Text as="p" numeric alignment="end">
                            {formatMoney(item.itemsCost, item.currency)}
                          </Text>
                          <Text as="p" tone="subdued" variant="bodySm" numeric alignment="end">
                            ×{item.itemCount}
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="p" numeric alignment="end">
                          {formatMoney(item.shippingCost, item.currency)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="p" fontWeight="semibold" numeric alignment="end">
                          {formatMoney(item.totalCost, item.currency)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <StatusBadge status={item.status} />
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {item.paymentDueAt ? (
                          <Tooltip content={formatDate(item.paymentDueAt)}>
                            <Badge tone={overdue ? "critical" : soon ? "warning" : undefined}>
                              {overdue ? t("payments.overdue") : `${Math.floor(item.hoursLeft ?? 0)} ${t("payments.hoursLeft")}`}
                            </Badge>
                          </Tooltip>
                        ) : (
                          <Text as="span" tone="subdued">
                            —
                          </Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {item.placedAt ? (
                          <Tooltip content={formatDate(item.placedAt)}>
                            <Text as="span">{relativeTime(item.placedAt)}</Text>
                          </Tooltip>
                        ) : (
                          <Text as="span" tone="subdued">
                            —
                          </Text>
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="100" wrap={false}>
                          {item.paymentUrl && (
                            <Button size="slim" variant={wasOpened ? "secondary" : "primary"} url={item.paymentUrl} external onClick={() => setOpened((p) => [...new Set([...p, item.id])])}>
                              {wasOpened ? t("payments.opened") : t("payments.pay")}
                            </Button>
                          )}
                          <Button size="slim" loading={markingThisRow} disabled={busy && !markingThisRow} onClick={() => submit("mark-paid", [item.id])}>
                            {t("payments.markPaid")}
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
              <SectionHeader title={t("payments.howItWorks.title")} />
              <Text as="p" tone="subdued">
                {t("payments.howItWorks.body")}
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
