import { useEffect, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Form, Link, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { Badge, BlockStack, Box, Button, Card, IndexTable, InlineGrid, Layout, Page, Select, Tabs, Text, TextField } from "@shopify/polaris";
import prisma from "~/db.server";
import { EmptyScreen } from "~/components/EmptyScreen";
import { Paginator } from "~/components/Paginator";
import { SectionHeader } from "~/components/SectionHeader";
import { Stat } from "~/components/Stat";
import { StatusBadge } from "~/components/StatusBadge";
import { requireShop } from "~/lib/auth.server";
import { formatDate, formatNumber, pageParam } from "~/lib/format";
import type { I18nKey } from "~/lib/i18n";
import { useT } from "~/lib/use-t";
import { queueStats } from "~/services/jobs/index.server";
import { listJobRuns } from "~/services/jobs.server";

const PAGE_SIZE = 50;
const JOB_LIMIT = 15;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const level = url.searchParams.get("level") ?? "";
  const q = url.searchParams.get("q") ?? "";
  const entity = url.searchParams.get("entity") ?? "";
  const page = pageParam(url.searchParams.get("page"));
  // The level tabs count within the entity and search filters, so a tab's
  // number is what the merchant will see when they click it.
  const baseWhere = {
    shopId: shop.id,
    ...(entity ? { entity } : {}),
    ...(q ? { message: { contains: q, mode: "insensitive" as const } } : {}),
  };
  const where = { ...baseWhere, ...(level ? { level } : {}) };
  const [logs, total, byLevel, jobs, queue] = await Promise.all([
    prisma.activityLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    prisma.activityLog.count({ where }),
    prisma.activityLog.groupBy({ by: ["level"], where: baseWhere, _count: { _all: true } }),
    listJobRuns(shop.id, { limit: JOB_LIMIT }),
    queueStats(),
  ]);
  const levelCounts: Record<string, number> = {};
  for (const row of byLevel) levelCounts[row.level] = row._count._all;
  return { logs, jobs, queue, filters: { level, q, entity }, page, pageSize: PAGE_SIZE, total, levelCounts };
};

const LEVEL_TONE: Record<string, "critical" | "warning" | "info" | undefined> = { error: "critical", warn: "warning", info: undefined, debug: undefined };
const LEVEL_TABS = ["", "error", "warn", "info", "debug"] as const;
const ENTITIES = ["Order", "Product", "ImportedProduct", "PricingRule", "SupplierAccount", "ShippingPreference", "StaffAccount"] as const;

export default function LogsPage() {
  const t = useT();
  const { logs, jobs, queue, filters, page, pageSize, total, levelCounts } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Polaris passes value/onChange straight to the DOM node, so a controlled
  // input with a no-op onChange cannot be typed in at all. Local state holds
  // what the merchant is editing until the GET form submits it.
  const [q, setQ] = useState(filters.q);
  const [entity, setEntity] = useState(filters.entity);

  useEffect(() => {
    setQ(filters.q);
    setEntity(filters.entity);
  }, [filters.q, filters.entity]);

  const linkFor = (entity: string | null, id: string | null) => {
    if (!entity || !id) return null;
    if (entity === "Order") return `/app/orders/${id}`;
    if (entity === "Product") return `/app/products/${id}`;
    if (entity === "ImportedProduct") return `/app/import/${id}`;
    return null;
  };

  const levelLabel = (level: string) => t(`logs.level.${level}` as I18nKey) ?? level;
  const entityLabel = (entity: string) => t(`logs.entity.${entity}` as I18nKey) ?? entity;
  const actorLabel = (actor: string) => t(`logs.actor.${actor}` as I18nKey) ?? actor;
  const jobLabel = (type: string) => t(`job.${type}` as I18nKey) ?? type;

  const allCount = Object.values(levelCounts).reduce((a, b) => a + b, 0);
  const tabs = LEVEL_TABS.filter((id) => id !== "debug" || (levelCounts.debug ?? 0) > 0).map((id) => ({
    id,
    content:
      id === ""
        ? `${t("logs.tab.all")} (${allCount})`
        : id === "error"
          ? `${t("logs.errors")} (${levelCounts.error ?? 0})`
          : id === "warn"
            ? `${t("logs.warnings")} (${levelCounts.warn ?? 0})`
            : id === "info"
              ? `${t("logs.info")} (${levelCounts.info ?? 0})`
              : `${t("logs.tab.debug")} (${levelCounts.debug ?? 0})`,
  }));
  const selectedTab = Math.max(0, tabs.findIndex((x) => x.id === filters.level));
  const filtered = Boolean(filters.level || filters.q || filters.entity);
  const errorCount = levelCounts.error ?? 0;

  return (
    <Page fullWidth title={t("page.logs.title")} subtitle={t("logs.subtitle")}>
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
            <Stat label={t("logs.stat.entries")} value={formatNumber(total)} hint={t("logs.stat.entriesHint")} />
            <Stat label={t("logs.stat.errors")} value={formatNumber(errorCount)} hint={t("logs.stat.errorsHint")} tone={errorCount > 0 ? "critical" : "default"} />
            <Stat label={t("logs.stat.queued")} value={formatNumber(queue.waiting)} hint={t("logs.stat.queuedHint", { n: queue.active })} />
            <Stat
              label={t("logs.stat.failedJobs")}
              value={formatNumber(queue.failed)}
              hint={queue.mode === "redis" ? t("logs.stat.queueRedis") : t("logs.stat.queueInline")}
              tone={queue.failed > 0 ? "critical" : "default"}
            />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box padding="300">
              <SectionHeader title={t("logs.backgroundJobs")} count={jobs.length} />
            </Box>
            {jobs.length === 0 ? (
              <EmptyScreen compact heading={t("logs.noJobs")} body={t("logs.jobs.emptyBody")} />
            ) : (
              <IndexTable
                selectable={false}
                resourceName={{ singular: t("logs.backgroundJobs"), plural: t("logs.backgroundJobs") }}
                itemCount={jobs.length}
                headings={[
                  { title: t("logs.jobs.column.job") },
                  { title: t("logs.jobs.column.status") },
                  { title: t("logs.jobs.column.progress"), alignment: "end" },
                  { title: t("logs.jobs.column.result"), alignment: "end" },
                  { title: t("logs.jobs.column.finished"), alignment: "end" },
                ]}
              >
                {jobs.map((j, index) => (
                  <IndexTable.Row id={j.id} key={j.id} position={index}>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">
                          {jobLabel(j.type)}
                        </Text>
                        <Text as="span" tone="subdued" variant="bodySm">
                          {j.type}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <StatusBadge status={j.status} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" alignment="end" numeric>
                        {j.processed}/{j.total}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" alignment="end" numeric tone={j.failed > 0 ? "critical" : "subdued"}>
                        {t("logs.jobs.result", { ok: j.succeeded, failed: j.failed })}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050" inlineAlign="end">
                        <Text as="span" tone="subdued" numeric>
                          {formatDate(j.finishedAt ?? j.startedAt ?? j.createdAt)}
                        </Text>
                        {j.error && (
                          <Text as="span" tone="critical" variant="bodySm">
                            {j.error}
                          </Text>
                        )}
                      </BlockStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Tabs
              tabs={tabs}
              selected={selectedTab}
              onSelect={(i) => {
                const sp = new URLSearchParams(params);
                if (tabs[i].id) sp.set("level", tabs[i].id);
                else sp.delete("level");
                sp.delete("page");
                navigate(`?${sp.toString()}`);
              }}
              fitted
            />
            <Box padding="300">
              <Form method="get">
                {/* The level tab is part of the filter, so a search keeps it. */}
                <input type="hidden" name="level" value={filters.level} />
                <InlineGrid columns={{ xs: 1, md: "2fr 1fr auto" }} gap="200" alignItems="end">
                  <TextField label={t("action.search")} name="q" value={q} onChange={setQ} autoComplete="off" placeholder={t("logs.searchPlaceholder")} clearButton onClearButtonClick={() => setQ("")} />
                  <Select
                    label={t("logs.entity")}
                    name="entity"
                    value={entity}
                    onChange={setEntity}
                    options={[{ label: t("common.all"), value: "" }, ...ENTITIES.map((value) => ({ label: entityLabel(value), value }))]}
                  />
                  <Button submit>{t("logs.filter")}</Button>
                </InlineGrid>
              </Form>
            </Box>
            {logs.length === 0 ? (
              filtered ? (
                <EmptyScreen heading={t("logs.emptyFiltered")} body={t("logs.emptyFilteredBody")} action={{ content: t("logs.clearFilters"), url: "/app/logs" }} />
              ) : (
                <EmptyScreen heading={t("logs.empty")} body={t("logs.emptyBody")} />
              )
            ) : (
              <IndexTable
                selectable={false}
                resourceName={{ singular: t("logs.resource.singular"), plural: t("logs.resource.plural") }}
                itemCount={logs.length}
                headings={[
                  { title: t("logs.column.time") },
                  { title: t("logs.column.level") },
                  { title: t("logs.column.actor") },
                  { title: t("logs.column.message") },
                  { title: t("logs.column.entity") },
                ]}
              >
                {logs.map((log, index) => {
                  const href = linkFor(log.entity, log.entityId);
                  return (
                    <IndexTable.Row id={log.id} key={log.id} position={index}>
                      <IndexTable.Cell>
                        <Text as="span" tone="subdued" numeric>
                          {formatDate(log.createdAt)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={LEVEL_TONE[log.level]}>{levelLabel(log.level)}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span">{actorLabel(log.actor)}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span">{href ? <Link to={href}>{log.message}</Link> : log.message}</Text>
                          <Text as="span" tone="subdued" variant="bodySm">
                            {log.action}
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {log.entity ? (
                          href ? (
                            <Link to={href}>{entityLabel(log.entity)}</Link>
                          ) : (
                            <Text as="span" tone="subdued">
                              {entityLabel(log.entity)}
                            </Text>
                          )
                        ) : (
                          <Text as="span" tone="subdued">
                            —
                          </Text>
                        )}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
            {total > pageSize && (
              <Box padding="300">
                <Paginator page={page} pageSize={pageSize} total={total} />
              </Box>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
