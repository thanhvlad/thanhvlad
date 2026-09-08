import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import type { PriceChangeAction, StockChangeAction } from "@prisma/client";
import { Badge, Banner, BlockStack, Box, Button, Card, Checkbox, DataTable, FormLayout, InlineStack, Layout, Page, Select, Text, TextField } from "@shopify/polaris";
import { JobProgress } from "~/components/JobProgress";
import { useJobRun } from "~/lib/use-job-run";
import { StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, relativeTime } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
import { getInventoryPolicy, runInventorySync, updateInventoryPolicy } from "~/services/inventory-sync.server";
import { createJobRun, listJobRuns } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { countProducts } from "~/services/products.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const [policy, runs, counts] = await Promise.all([getInventoryPolicy(shop.id), listJobRuns(shop.id, { type: "inventory-sync", limit: 10 }), countProducts(shop.id)]);
  return {
    policy: {
      isEnabled: policy.isEnabled,
      priceAction: policy.priceAction,
      priceThresholdPercent: policy.priceThresholdPercent.toString(),
      stockAction: policy.stockAction,
      lowStockThreshold: policy.lowStockThreshold,
      maxInventoryPushed: policy.maxInventoryPushed,
      onProductRemoved: policy.onProductRemoved,
      syncIntervalMinutes: policy.syncIntervalMinutes,
      lastRunAt: policy.lastRunAt,
    },
    runs: runs.map((r) => ({ id: r.id, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, result: r.result as Record<string, unknown>, error: r.error })),
    counts,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, graphql, actor } = await requireShop(request);
  const { intent, get } = await readForm(request);
  try {
    switch (intent) {
      case "save":
        await updateInventoryPolicy(shop.id, {
          isEnabled: get("isEnabled") === "true",
          priceAction: get("priceAction") as PriceChangeAction,
          priceThresholdPercent: get("priceThresholdPercent") || "0",
          stockAction: get("stockAction") as StockChangeAction,
          lowStockThreshold: Number(get("lowStockThreshold") || 0),
          maxInventoryPushed: Number(get("maxInventoryPushed") || 50),
          onProductRemoved: get("onProductRemoved") as StockChangeAction,
          syncIntervalMinutes: Math.max(30, Number(get("syncIntervalMinutes") || 360)),
        });
        return { ok: true, messageKey: "msg.policySaved" };
      case "run": {
        const total = (await countProducts(shop.id)).autoUpdate;
        const job = await createJobRun({ shopId: shop.id, type: "inventory-sync", total });
        await enqueue("inventory-sync", { shopId: shop.id, jobRunId: job.id, actor }, { dedupeKey: `inventory-manual-${shop.id}-${Date.now()}` });
        return { ok: true, jobRunId: job.id };
      }
      case "dry-run": {
        const result = await runInventorySync(shop, graphql, { dryRun: true, actor });
        return { ok: true, dryRun: { summary: { productsChecked: result.productsChecked, suppliersRefreshed: result.suppliersRefreshed, suppliersFailed: result.suppliersFailed, errors: result.errors }, actions: result.plannedActions.map((a) => ({ type: a.type, variant: a.shopifyVariantId, reason: a.reason, price: a.price ?? null, quantity: a.quantity ?? null })) } };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function InventoryPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string; jobRunId?: string; dryRun?: { summary: Record<string, unknown>; actions: Array<{ type: string; variant: string; reason: string; price: string | null; quantity: number | null }> } } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const [form, setForm] = useState({ ...data.policy, priceThresholdPercent: data.policy.priceThresholdPercent, lowStockThreshold: String(data.policy.lowStockThreshold), maxInventoryPushed: String(data.policy.maxInventoryPushed), syncIntervalMinutes: String(data.policy.syncIntervalMinutes) });
  const { jobRunId, clearJobRun } = useJobRun(result);

  return (
    <Page
      title={t("page.inventory.title")}
      subtitle={`${data.counts.autoUpdate}/${data.counts.total} ${t("inventory.subtitle.onAutoUpdate")} · ${t("inventory.subtitle.lastRun")} ${relativeTime(data.policy.lastRunAt)}`}
      primaryAction={{ content: t("inventory.runNow"), onAction: () => fetcher.submit({ intent: "run" }, { method: "post" }), loading: fetcher.state !== "idle" }}
      secondaryActions={[{ content: t("inventory.previewChanges"), onAction: () => fetcher.submit({ intent: "dry-run" }, { method: "post" }) }]}
    >
      <Layout>
        <Layout.Section>
          <JobProgress jobRunId={jobRunId} onDone={clearJobRun} />
          {actionMessage && (
            <Banner tone="success">
              <p>{actionMessage}</p>
            </Banner>
          )}
          {result?.error && (
            <Banner tone="critical">
              <p>{result.error}</p>
            </Banner>
          )}
          {result?.dryRun && (
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  {`${t("inventory.dryRun.title")}: ${result.dryRun.actions.length} ${t("inventory.dryRun.changesApplied")}`}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {`${String(result.dryRun.summary.productsChecked)} ${t("inventory.dryRun.productsChecked")} · ${String(result.dryRun.summary.suppliersRefreshed)} ${t("inventory.dryRun.suppliersRefreshed")} · ${String(result.dryRun.summary.suppliersFailed)} ${t("inventory.dryRun.failed")}`}
                </Text>
                {result.dryRun.actions.length > 0 && (
                  <DataTable columnContentTypes={["text", "text", "text"]} headings={[t("inventory.table.action"), t("inventory.table.variant"), t("inventory.table.reason")]} rows={result.dryRun.actions.slice(0, 200).map((a) => [a.type, a.variant.split("/").pop() ?? a.variant, a.reason])} />
                )}
              </BlockStack>
            </Card>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  {t("inventory.policy")}
                </Text>
                <Checkbox label={t("inventory.autoSyncEnabled")} checked={form.isEnabled} onChange={(v) => setForm({ ...form, isEnabled: v })} />
              </InlineStack>
              <FormLayout>
                <FormLayout.Group>
                  <Select
                    label={t("inventory.priceAction.label")}
                    value={form.priceAction}
                    onChange={(v) => setForm({ ...form, priceAction: v as PriceChangeAction })}
                    options={[
                      { label: t("inventory.priceAction.updatePrice"), value: "UPDATE_PRICE" },
                      { label: t("inventory.action.notifyOnly"), value: "NOTIFY_ONLY" },
                      { label: t("inventory.action.doNothing"), value: "DO_NOTHING" },
                    ]}
                  />
                  <TextField label={t("inventory.priceThreshold")} type="number" value={form.priceThresholdPercent} onChange={(v) => setForm({ ...form, priceThresholdPercent: v })} autoComplete="off" />
                </FormLayout.Group>
                <FormLayout.Group>
                  <Select
                    label={t("inventory.stockAction.label")}
                    value={form.stockAction}
                    onChange={(v) => setForm({ ...form, stockAction: v as StockChangeAction })}
                    options={[
                      { label: t("inventory.stockAction.setZero"), value: "SET_ZERO_WHEN_OUT" },
                      { label: t("inventory.stockAction.mirrorQuantity"), value: "UPDATE_QUANTITY" },
                      { label: t("inventory.stockAction.unpublish"), value: "UNPUBLISH_WHEN_OUT" },
                      { label: t("inventory.action.notifyOnly"), value: "NOTIFY_ONLY" },
                      { label: t("inventory.action.doNothing"), value: "DO_NOTHING" },
                    ]}
                  />
                  <TextField label={t("inventory.lowStockThreshold")} type="number" value={form.lowStockThreshold} onChange={(v) => setForm({ ...form, lowStockThreshold: v })} autoComplete="off" />
                  <TextField label={t("inventory.maxInventoryPushed")} type="number" value={form.maxInventoryPushed} onChange={(v) => setForm({ ...form, maxInventoryPushed: v })} autoComplete="off" />
                </FormLayout.Group>
                <FormLayout.Group>
                  <Select
                    label={t("inventory.onRemoved.label")}
                    value={form.onProductRemoved}
                    onChange={(v) => setForm({ ...form, onProductRemoved: v as StockChangeAction })}
                    options={[
                      { label: t("inventory.onRemoved.unpublish"), value: "UNPUBLISH_WHEN_OUT" },
                      { label: t("inventory.onRemoved.setZero"), value: "SET_ZERO_WHEN_OUT" },
                      { label: t("inventory.action.notifyOnly"), value: "NOTIFY_ONLY" },
                      { label: t("inventory.action.doNothing"), value: "DO_NOTHING" },
                    ]}
                  />
                  <TextField label={t("inventory.syncInterval")} type="number" value={form.syncIntervalMinutes} onChange={(v) => setForm({ ...form, syncIntervalMinutes: v })} autoComplete="off" helpText={t("inventory.syncIntervalHelp")} />
                </FormLayout.Group>
                <Button variant="primary" onClick={() => fetcher.submit({ intent: "save", ...form, isEnabled: String(form.isEnabled) }, { method: "post" })} loading={fetcher.state !== "idle"}>
                  {t("inventory.savePolicy")}
                </Button>
              </FormLayout>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("inventory.recentRuns")}
              </Text>
              {data.runs.length === 0 && (
                <Text as="p" tone="subdued">
                  {t("inventory.noRuns")}
                </Text>
              )}
              {data.runs.map((run) => (
                <Box key={run.id} padding="200" borderColor="border" borderWidth="025" borderRadius="200">
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <InlineStack gap="200" blockAlign="center">
                      <StatusBadge status={run.status} />
                      <Text as="span" variant="bodySm">
                        {formatDate(run.startedAt ?? run.finishedAt)}
                      </Text>
                    </InlineStack>
                    <InlineStack gap="100">
                      {run.result && typeof run.result.productsChecked === "number" && (
                        <>
                          <Badge>{`${run.result.productsChecked} ${t("inventory.badge.checked")}`}</Badge>
                          <Badge tone="info">{`${run.result.priceUpdates} ${t("inventory.badge.price")}`}</Badge>
                          <Badge tone="warning">{`${run.result.inventoryUpdates} ${t("inventory.badge.stock")}`}</Badge>
                          <Badge tone="critical">{`${run.result.unpublished} ${t("inventory.badge.unpublished")}`}</Badge>
                        </>
                      )}
                      {run.error && (
                        <Text as="span" tone="critical" variant="bodySm">
                          {run.error}
                        </Text>
                      )}
                    </InlineStack>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
