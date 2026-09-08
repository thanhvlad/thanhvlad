import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Form, Link, useLoaderData } from "@remix-run/react";
import { Badge, BlockStack, Box, Button, Card, EmptyState, InlineStack, Layout, Page, Select, Text, TextField } from "@shopify/polaris";
import prisma from "~/db.server";
import { requireShop } from "~/lib/auth.server";
import { formatDate } from "~/lib/format";
import { queueStats } from "~/services/jobs/index.server";
import { listJobRuns } from "~/services/jobs.server";
import { StatusBadge } from "~/components/StatusBadge";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const level = url.searchParams.get("level") ?? "";
  const q = url.searchParams.get("q") ?? "";
  const entity = url.searchParams.get("entity") ?? "";
  const [logs, jobs, queue] = await Promise.all([
    prisma.activityLog.findMany({
      where: { shopId: shop.id, ...(level ? { level } : {}), ...(entity ? { entity } : {}), ...(q ? { message: { contains: q, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    listJobRuns(shop.id, { limit: 15 }),
    queueStats(),
  ]);
  return { logs, jobs, queue, filters: { level, q, entity } };
};

const LEVEL_TONE: Record<string, "critical" | "warning" | "info" | undefined> = { error: "critical", warn: "warning", info: undefined, debug: undefined };

export default function LogsPage() {
  const { logs, jobs, queue, filters } = useLoaderData<typeof loader>();
  // Polaris passes value/onChange straight to the DOM node, so a controlled
  // input with a no-op onChange cannot be typed in at all. Local state holds
  // what the merchant is editing until the GET form submits it.
  const [q, setQ] = useState(filters.q);
  const [level, setLevel] = useState(filters.level);
  const [entity, setEntity] = useState(filters.entity);

  useEffect(() => {
    setQ(filters.q);
    setLevel(filters.level);
    setEntity(filters.entity);
  }, [filters.q, filters.level, filters.entity]);

  const linkFor = (entity: string | null, id: string | null) => {
    if (!entity || !id) return null;
    if (entity === "Order") return `/app/orders/${id}`;
    if (entity === "Product") return `/app/products/${id}`;
    if (entity === "ImportedProduct") return `/app/import/${id}`;
    return null;
  };
  return (
    <Page title="Activity" subtitle={`Queue: ${queue.mode === "redis" ? `Redis · ${queue.waiting} waiting · ${queue.active} active · ${queue.failed} failed` : "inline (no Redis)"}`}>
      <Layout>
        <Layout.Section>
          <Card>
            <Form method="get">
              <InlineStack gap="200" blockAlign="end" wrap>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <TextField label="Search" name="q" value={q} onChange={setQ} autoComplete="off" />
                </div>
                <Select label="Level" name="level" value={level} onChange={setLevel} options={[{ label: "All levels", value: "" }, { label: "Errors", value: "error" }, { label: "Warnings", value: "warn" }, { label: "Info", value: "info" }]} />
                <Select label="Entity" name="entity" value={entity} onChange={setEntity} options={[{ label: "All", value: "" }, { label: "Orders", value: "Order" }, { label: "Products", value: "Product" }, { label: "Import list", value: "ImportedProduct" }, { label: "Pricing rules", value: "PricingRule" }, { label: "Supplier accounts", value: "SupplierAccount" }]} />
                <Button submit>Filter</Button>
              </InlineStack>
            </Form>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Background jobs
              </Text>
              {jobs.length === 0 && (
                <Text as="p" tone="subdued">
                  No jobs yet.
                </Text>
              )}
              {jobs.map((j) => (
                <InlineStack key={j.id} align="space-between" blockAlign="center" wrap>
                  <InlineStack gap="200" blockAlign="center">
                    <StatusBadge status={j.status} />
                    <Text as="span">{j.type}</Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {j.processed}/{j.total} · {j.succeeded} ok · {j.failed} failed
                    </Text>
                  </InlineStack>
                  <Text as="span" tone="subdued" variant="bodySm">
                    {formatDate(j.finishedAt ?? j.startedAt ?? j.createdAt)}
                    {j.error ? ` · ${j.error}` : ""}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {logs.length === 0 ? (
              <EmptyState heading="No activity yet" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>Every import, push, order placement and sync is recorded here.</p>
              </EmptyState>
            ) : (
              logs.map((log) => {
                const href = linkFor(log.entity, log.entityId);
                return (
                  <Box key={log.id} padding="300" borderBlockEndWidth="025" borderColor="border">
                    <InlineStack align="space-between" blockAlign="start" gap="300" wrap={false}>
                      <BlockStack gap="050">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={LEVEL_TONE[log.level]}>{log.action}</Badge>
                          <Text as="p">{href ? <Link to={href}>{log.message}</Link> : log.message}</Text>
                        </InlineStack>
                        <Text as="p" tone="subdued" variant="bodySm">
                          {formatDate(log.createdAt)} · {log.actor}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </Box>
                );
              })
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
