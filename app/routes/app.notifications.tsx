import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, ButtonGroup, Card, IndexTable, InlineStack, Layout, Page, Tabs, Text, useIndexResourceState } from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { readForm, requireShop } from "~/lib/auth.server";
import { formatDay, pageParam } from "~/lib/format";
import type { I18nKey, Translator } from "~/lib/i18n";
import { useT } from "~/lib/use-t";
import { downloadAuthed } from "~/lib/download.client";
import { Paginator } from "~/components/Paginator";
import { archiveNotifications, countNotifications, countUnread, listNotifications, markRead } from "~/services/notifications.server";

type Tab = "all" | "unread";

const PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const tab: Tab = url.searchParams.get("tab") === "unread" ? "unread" : "all";
  // The two tab counts are the only figures this screen leads with; the
  // unread one is what the merchant came here to clear.
  const requestedPage = pageParam(url.searchParams.get("page"));
  const [unread, all] = await Promise.all([countUnread(shop.id), countNotifications(shop.id)]);
  // The tab label promised a number the table could not reach: it counted every
  // notification while the list stopped at 100, so a busy store read
  // "All (612)" above exactly 100 rows with no way to the rest.
  const total = tab === "unread" ? unread : all;
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / PAGE_SIZE)));
  const notifications = await listNotifications(shop.id, {
    limit: PAGE_SIZE,
    skip: (page - 1) * PAGE_SIZE,
    unreadOnly: tab === "unread",
  });
  return { notifications, tab, counts: { all, unread }, page, pageSize: PAGE_SIZE, total };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { intent, get } = await readForm(request);
  // A single `id` (row button) and a comma-joined `ids` (bulk action) reach
  // the same service, which already takes a list.
  const ids = (get("ids") || get("id"))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let changed = 0;
  if (intent === "read-all") changed = (await markRead(shop.id, "all")).count;
  if (intent === "read") changed = (await markRead(shop.id, ids)).count;
  if (intent === "archive") changed = (await archiveNotifications(shop.id, ids)).count;
  if (intent === "archive-all") changed = (await archiveNotifications(shop.id, "all")).count;
  // The count is what the database actually touched: marking ten selected rows
  // read when only three were unread changes three, and saying "10" is a lie.
  return { ok: true, changed };
};

const TONES: Record<string, "info" | "warning" | "critical" | "success" | undefined> = { info: "info", warning: "warning", critical: "critical" };

/**
 * "5 min ago" in the merchant's language. `relativeTime` in ~/lib/format is
 * English-only, and a time label is a visible string like any other.
 */
function relativeLabel(value: string | Date, t: Translator): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (Math.abs(minutes) < 1) return t("notifications.time.justNow");
  if (Math.abs(minutes) < 60) return t("notifications.time.minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return t("notifications.time.hours", { n: hours });
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return t("notifications.time.days", { n: days });
  return formatDay(date);
}

type Outcome = { intent: string; count: number };

function outcomeText(outcome: Outcome, t: Translator): string {
  // Nothing changed is its own outcome: every row picked was already read, or
  // already archived. Saying "Marked as read." there would be a small lie.
  if (outcome.count === 0) return t("notifications.done.nothing");
  switch (outcome.intent) {
    case "read-all":
      return t("notifications.done.readAll");
    case "archive-all":
      return t("notifications.done.archiveAll");
    case "read":
      return outcome.count > 1 ? t("notifications.done.readMany", { n: outcome.count }) : t("notifications.done.read");
    default:
      return outcome.count > 1 ? t("notifications.done.archiveMany", { n: outcome.count }) : t("notifications.done.archive");
  }
}

export default function NotificationsPage() {
  const t = useT();
  const { notifications, tab, counts, page, pageSize, total } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(notifications);

  const busy = fetcher.state !== "idle";
  const busyIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const busyId = busy ? String(fetcher.formData?.get("id") ?? "") : "";

  // Which action ran is remembered across the submit → idle transition; how
  // many rows it changed comes back from the action itself.
  const pending = useRef<Outcome | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && pending.current && fetcher.data?.ok) {
      setOutcome({ ...pending.current, count: fetcher.data.changed ?? pending.current.count });
      pending.current = null;
      clearSelection();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const submit = (intent: string, extra: Record<string, string> = {}, count = 1) => {
    pending.current = { intent, count };
    fetcher.submit({ intent, ...extra }, { method: "post" });
  };

  const tabs: Array<{ id: Tab; content: string }> = [
    { id: "all", content: `${t("notifications.tab.all")} (${counts.all})` },
    { id: "unread", content: `${t("notifications.tab.unread")} (${counts.unread})` },
  ];
  const selectedTab = Math.max(0, tabs.findIndex((x) => x.id === tab));

  const severityLabel = (severity: string) => t(`notifications.severity.${severity}` as I18nKey) ?? severity;
  const typeLabel = (type: string) => t(`notifications.type.${type}` as I18nKey) ?? type;

  return (
    <Page
      fullWidth
      title={t("page.notifications.title")}
      subtitle={t("notifications.subtitle")}
      primaryAction={{
        content: t("notifications.markAllRead"),
        onAction: () => submit("read-all"),
        disabled: counts.unread === 0 || busy,
        loading: busyIntent === "read-all",
      }}
      secondaryActions={[
        {
          content: t("notifications.archiveAll"),
          onAction: () => submit("archive-all"),
          disabled: counts.all === 0 || busy,
          loading: busyIntent === "archive-all",
        },
      ]}
    >
      <Layout>
        {outcome && (
          <Layout.Section>
            <Banner tone={outcome.count === 0 ? "info" : "success"} onDismiss={() => setOutcome(null)}>
              <p>{outcomeText(outcome, t)}</p>
            </Banner>
          </Layout.Section>
        )}
        <Layout.Section>
          <Card padding="0">
            <Tabs
              tabs={tabs}
              selected={selectedTab}
              onSelect={(i) => {
                const sp = new URLSearchParams(params);
                sp.set("tab", tabs[i].id);
                navigate(`?${sp.toString()}`);
              }}
              fitted
            />
            {notifications.length === 0 ? (
              tab === "unread" ? (
                <EmptyScreen
                  compact
                  heading={t("notifications.emptyUnread")}
                  body={t("notifications.emptyUnreadBody")}
                  action={{ content: t("notifications.viewAll"), url: "/app/notifications?tab=all" }}
                />
              ) : (
                <EmptyScreen
                  compact
                  heading={t("notifications.empty")}
                  body={t("notifications.emptyBody")}
                  action={{ content: t("notifications.settings"), url: "/app/settings" }}
                />
              )
            ) : (
              <IndexTable
                resourceName={{ singular: t("notifications.resource.singular"), plural: t("notifications.resource.plural") }}
                itemCount={notifications.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                loading={busy}
                promotedBulkActions={[
                  {
                    content: t("notifications.bulk.markRead"),
                    onAction: () => submit("read", { ids: selectedResources.join(",") }, selectedResources.length),
                  },
                  {
                    content: t("notifications.bulk.archive"),
                    onAction: () => submit("archive", { ids: selectedResources.join(",") }, selectedResources.length),
                  },
                ]}
                headings={[
                  { title: t("notifications.column.severity") },
                  { title: t("notifications.column.notification") },
                  { title: t("notifications.column.type") },
                  { title: t("notifications.column.time"), alignment: "end" },
                  { title: t("notifications.column.actions"), alignment: "end" },
                ]}
              >
                {notifications.map((n, index) => {
                  const unread = !n.readAt;
                  const hasExport = Boolean((n.meta as { dataRequest?: unknown } | null)?.dataRequest);
                  return (
                    // Read rows step back; what is left standing out is what
                    // still needs the merchant.
                    <IndexTable.Row id={n.id} key={n.id} position={index} selected={selectedResources.includes(n.id)} tone={unread ? undefined : "subdued"}>
                      <IndexTable.Cell>
                        <Badge tone={TONES[n.severity]}>{severityLabel(n.severity)}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span" fontWeight={unread ? "semibold" : "regular"}>
                            {n.link ? <Link to={n.link}>{n.title}</Link> : n.title}
                          </Text>
                          {n.body && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              {n.body}
                            </Text>
                          )}
                          {hasExport && (
                            <Box paddingBlockStart="100">
                              <Button size="slim" onClick={() => downloadAuthed(`/app/notifications/${n.id}/export`, `customer-data-request-${n.id}.json`)}>
                                {t("notifications.downloadExport")}
                              </Button>
                            </Box>
                          )}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" tone="subdued">
                          {typeLabel(n.type)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack align="end">
                          <Text as="span" tone="subdued" numeric>
                            {relativeLabel(n.createdAt, t)}
                          </Text>
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack align="end">
                          <ButtonGroup>
                            {unread && (
                              <Button size="slim" disabled={busy} loading={busyIntent === "read" && busyId === n.id} onClick={() => submit("read", { id: n.id })}>
                                {t("notifications.markRead")}
                              </Button>
                            )}
                            <Button size="slim" disabled={busy} loading={busyIntent === "archive" && busyId === n.id} onClick={() => submit("archive", { id: n.id })}>
                              {t("notifications.archive")}
                            </Button>
                          </ButtonGroup>
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
          </Card>
          <Box paddingBlockStart="400">
            <Paginator page={page} pageSize={pageSize} total={total} />
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
