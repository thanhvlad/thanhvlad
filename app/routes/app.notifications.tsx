import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import { Badge, BlockStack, Box, Button, Card, EmptyState, InlineStack, Layout, Page, Text } from "@shopify/polaris";
import { readForm, requireShop } from "~/lib/auth.server";
import { relativeTime } from "~/lib/format";
import { useT } from "~/lib/use-t";
import { archiveNotifications, listNotifications, markRead } from "~/services/notifications.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const notifications = await listNotifications(shop.id, { limit: 100 });
  return { notifications };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { intent, get } = await readForm(request);
  if (intent === "read-all") await markRead(shop.id, "all");
  if (intent === "read") await markRead(shop.id, [get("id")]);
  if (intent === "archive") await archiveNotifications(shop.id, [get("id")]);
  if (intent === "archive-all") await archiveNotifications(shop.id, "all");
  return { ok: true };
};

const TONES: Record<string, "info" | "warning" | "critical" | "success" | undefined> = { info: "info", warning: "warning", critical: "critical" };

export default function NotificationsPage() {
  const t = useT();
  const { notifications } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();
  return (
    <Page
      title={t("page.notifications.title")}
      primaryAction={{ content: t("notifications.markAllRead"), onAction: () => fetcher.submit({ intent: "read-all" }, { method: "post" }), disabled: notifications.every((n) => n.readAt) }}
      secondaryActions={[{ content: t("notifications.archiveAll"), onAction: () => fetcher.submit({ intent: "archive-all" }, { method: "post" }), disabled: notifications.length === 0 }]}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            {notifications.length === 0 ? (
              <EmptyState heading={t("notifications.empty")} image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>{t("notifications.emptyBody")}</p>
              </EmptyState>
            ) : (
              <BlockStack gap="0">
                {notifications.map((n) => (
                  <Box key={n.id} padding="300" borderBlockEndWidth="025" borderColor="border" background={n.readAt ? undefined : "bg-surface-secondary"}>
                    <InlineStack align="space-between" blockAlign="start" gap="300" wrap={false}>
                      <BlockStack gap="050">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={TONES[n.severity]}>{n.type}</Badge>
                          <Text as="p" fontWeight={n.readAt ? "regular" : "semibold"}>
                            {n.link ? <Link to={n.link}>{n.title}</Link> : n.title}
                          </Text>
                        </InlineStack>
                        {n.body && (
                          <Text as="p" tone="subdued" variant="bodySm">
                            {n.body}
                          </Text>
                        )}
                        {Boolean((n.meta as { dataRequest?: unknown } | null)?.dataRequest) && (
                          <InlineStack>
                            <Button size="slim" url={`/app/notifications/${n.id}/export`} target="_blank">
                              {t("notifications.downloadExport")}
                            </Button>
                          </InlineStack>
                        )}
                        <Text as="p" tone="subdued" variant="bodySm">
                          {relativeTime(n.createdAt)}
                        </Text>
                      </BlockStack>
                      <InlineStack gap="100">
                        {!n.readAt && (
                          <Button size="slim" onClick={() => fetcher.submit({ intent: "read", id: n.id }, { method: "post" })}>
                            {t("notifications.markRead")}
                          </Button>
                        )}
                        <Button size="slim" onClick={() => fetcher.submit({ intent: "archive", id: n.id }, { method: "post" })}>
                          {t("notifications.archive")}
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </Box>
                ))}
              </BlockStack>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
