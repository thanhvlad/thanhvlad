import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { PriceChangeAction, StockChangeAction } from "@prisma/client";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { JobProgress } from "~/components/JobProgress";
import { SectionHeader } from "~/components/SectionHeader";
import { Stat } from "~/components/Stat";
import { StatusBadge } from "~/components/StatusBadge";
import { useJobRun } from "~/lib/use-job-run";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import type { I18nKey } from "~/lib/i18n";
import { formatDate, formatMoney, relativeTime, truncate } from "~/lib/format";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
import { getInventoryPolicy, runInventorySync, updateInventoryPolicy } from "~/services/inventory-sync.server";
import { createJobRun, listJobRuns } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { countProducts } from "~/services/products.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const [policy, runs, counts] = await Promise.all([getInventoryPolicy(shop.id), listJobRuns(shop.id, { type: "inventory-sync", limit: 10 }), countProducts(shop.id)]);
  return {
    currency: shop.currency,
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

type ActionResult = { ok?: boolean; error?: string; messageKey?: string; jobRunId?: string; dryRun?: DryRun };
type DryRun = { summary: { productsChecked: number; suppliersRefreshed: number; suppliersFailed: number; errors: string[] }; actions: DryRunAction[] };
type DryRunAction = { type: string; variant: string; reason: string; price: string | null; quantity: number | null };

/** A job's stored result is untyped JSON; only numbers that are really there count. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The dry run lists every planned change; the table shows this many before it stops. */
const DRY_RUN_ROWS = 200;

export default function InventoryPage() {
  const t = useT();
  const shopify = useAppBridge();
  const data = useLoaderData<typeof loader>();

  // One fetcher per action, so "Run now" does not spin while a policy saves and
  // a dry run does not wipe the progress of a real run.
  const saveFetcher = useFetcher<typeof action>();
  const runFetcher = useFetcher<typeof action>();
  const dryRunFetcher = useFetcher<typeof action>();
  const saveResult = saveFetcher.data as ActionResult | undefined;
  const runResult = runFetcher.data as ActionResult | undefined;
  const dryRunResult = dryRunFetcher.data as ActionResult | undefined;

  const saveMessage = useMessage(saveResult);
  const saveError = useErrorMessage(saveResult);
  const runError = useErrorMessage(runResult);
  const dryRunError = useErrorMessage(dryRunResult);
  const { jobRunId, clearJobRun } = useJobRun(runResult);

  // Only the fields the form owns and submits. Spreading all of data.policy
  // pulled in lastRunAt, which a background run changes - and the screen then
  // reported unsaved edits the merchant never made.
  const initialForm = {
    isEnabled: data.policy.isEnabled,
    priceAction: data.policy.priceAction,
    priceThresholdPercent: data.policy.priceThresholdPercent,
    stockAction: data.policy.stockAction,
    lowStockThreshold: String(data.policy.lowStockThreshold),
    maxInventoryPushed: String(data.policy.maxInventoryPushed),
    onProductRemoved: data.policy.onProductRemoved,
    syncIntervalMinutes: String(data.policy.syncIntervalMinutes),
  };
  const [form, setForm] = useState(initialForm);
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);

  // "Saved." is a toast, not a banner: it needs no reading. Keyed on the data
  // object so a second save with the same wording still confirms.
  useEffect(() => {
    if (saveFetcher.state === "idle" && saveResult?.ok && saveMessage) shopify.toast.show(saveMessage);
  }, [saveFetcher.state, saveResult, saveMessage, shopify]);

  const runNow = () => runFetcher.submit({ intent: "run" }, { method: "post" });
  const previewChanges = () => dryRunFetcher.submit({ intent: "dry-run" }, { method: "post" });
  const savePolicy = () => saveFetcher.submit({ intent: "save", ...form, isEnabled: String(form.isEnabled) }, { method: "post" });

  // The newest run can be the one still queued, whose result is null. The
  // in-flight job already shows in JobProgress and the runs table; these
  // figures want the most recent run that actually produced any.
  const lastRun = data.runs.find((r) => num(r.result?.productsChecked) !== null) ?? data.runs[0];
  const checked = num(lastRun?.result?.productsChecked);
  const priceUpdates = num(lastRun?.result?.priceUpdates);
  const stockUpdates = num(lastRun?.result?.inventoryUpdates);
  const unpublished = num(lastRun?.result?.unpublished);
  const changes = checked === null ? null : (priceUpdates ?? 0) + (stockUpdates ?? 0) + (unpublished ?? 0);

  const dryRun = dryRunResult?.dryRun;
  const errors = [saveError, runError, dryRunError].filter((e): e is string => Boolean(e));

  return (
    <Page
      title={t("page.inventory.title")}
      subtitle={t("inventory.subtitle")}
      primaryAction={{ content: t("inventory.runNow"), onAction: runNow, loading: runFetcher.state !== "idle", disabled: Boolean(jobRunId) }}
      secondaryActions={[{ content: t("inventory.previewChanges"), onAction: previewChanges, loading: dryRunFetcher.state !== "idle" }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <JobProgress jobRunId={jobRunId} onDone={clearJobRun} />
            {errors.map((error) => (
              <Banner key={error} tone="critical">
                <p>{error}</p>
              </Banner>
            ))}

            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
              <Stat
                label={t("inventory.stat.lastRun")}
                value={data.policy.lastRunAt ? relativeTime(data.policy.lastRunAt) : t("inventory.stat.never")}
                hint={data.policy.isEnabled ? t("inventory.stat.checksEvery", { n: data.policy.syncIntervalMinutes }) : t("inventory.stat.autoOff")}
                tone={data.policy.isEnabled ? "default" : "warning"}
              />
              <Stat label={t("inventory.stat.onAutoUpdate")} value={String(data.counts.autoUpdate)} hint={t("inventory.stat.ofTotal", { n: data.counts.total })} />
              {checked !== null && <Stat label={t("inventory.stat.checked")} value={String(checked)} hint={t("inventory.stat.inLastRun")} />}
              {changes !== null && (
                <Stat
                  label={t("inventory.stat.changes")}
                  value={String(changes)}
                  hint={t("inventory.stat.changesHint", { price: priceUpdates ?? 0, stock: stockUpdates ?? 0, unpublished: unpublished ?? 0 })}
                  tone={changes > 0 ? "success" : "default"}
                />
              )}
            </InlineGrid>

            {dryRun && <DryRunCard dryRun={dryRun} currency={data.currency} />}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <SectionHeader title={t("inventory.policy")} />
              <Text as="p" tone="subdued">
                {t("inventory.policy.help")}
              </Text>
              <FormLayout>
                <Checkbox label={t("inventory.autoSyncEnabled")} helpText={t("inventory.enabledHelp")} checked={form.isEnabled} onChange={(v) => setForm({ ...form, isEnabled: v })} />
                <FormLayout.Group title={t("inventory.form.priceRules")}>
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
                  <TextField label={t("inventory.priceThreshold")} type="number" min={0} suffix="%" value={form.priceThresholdPercent} onChange={(v) => setForm({ ...form, priceThresholdPercent: v })} autoComplete="off" />
                </FormLayout.Group>
                <FormLayout.Group title={t("inventory.form.stockRules")}>
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
                  <TextField label={t("inventory.lowStockThreshold")} type="number" min={0} value={form.lowStockThreshold} onChange={(v) => setForm({ ...form, lowStockThreshold: v })} autoComplete="off" />
                  <TextField label={t("inventory.maxInventoryPushed")} type="number" min={0} value={form.maxInventoryPushed} onChange={(v) => setForm({ ...form, maxInventoryPushed: v })} autoComplete="off" />
                </FormLayout.Group>
                <FormLayout.Group title={t("inventory.form.schedule")}>
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
                  <TextField label={t("inventory.syncInterval")} type="number" min={30} value={form.syncIntervalMinutes} onChange={(v) => setForm({ ...form, syncIntervalMinutes: v })} autoComplete="off" helpText={t("inventory.syncIntervalHelp")} />
                </FormLayout.Group>
                <InlineStack align="end">
                  <Button variant="primary" onClick={savePolicy} loading={saveFetcher.state !== "idle"} disabled={!dirty}>
                    {t("inventory.savePolicy")}
                  </Button>
                </InlineStack>
              </FormLayout>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <SectionHeader title={t("inventory.recentRuns")} />
              {data.runs.length === 0 ? (
                <EmptyScreen compact heading={t("inventory.runs.empty.heading")} body={t("inventory.runs.empty.body")} action={{ content: t("inventory.runNow"), onAction: runNow }} />
              ) : (
                <DataTable
                  columnContentTypes={["text", "text", "text", "numeric", "numeric", "numeric", "numeric", "numeric", "text"]}
                  headings={[
                    t("inventory.runs.started"),
                    t("common.status"),
                    t("inventory.runs.duration"),
                    t("inventory.runs.checked"),
                    t("inventory.runs.priceUpdates"),
                    t("inventory.runs.stockUpdates"),
                    t("inventory.runs.unpublished"),
                    t("inventory.runs.suppliersFailed"),
                    t("inventory.runs.notes"),
                  ]}
                  rows={data.runs.map((run) => [
                    formatDate(run.startedAt ?? run.finishedAt),
                    <StatusBadge key={`${run.id}-status`} status={run.status} />,
                    formatDuration(run.startedAt, run.finishedAt, t),
                    num(run.result?.productsChecked) ?? "—",
                    num(run.result?.priceUpdates) ?? "—",
                    num(run.result?.inventoryUpdates) ?? "—",
                    num(run.result?.unpublished) ?? "—",
                    num(run.result?.suppliersFailed) ?? "—",
                    run.error ? (
                      // The full reason is what a merchant needs to act on; the
                      // column shows the head of it and the rest on hover.
                      <Tooltip key={`${run.id}-error`} content={run.error} preferredPosition="above">
                        <Text as="span" tone="critical" variant="bodySm">
                          {truncate(run.error, 80)}
                        </Text>
                      </Tooltip>
                    ) : (
                      ""
                    ),
                  ])}
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
 * What the next run would do, from a dry run. Nothing here has happened yet,
 * and the card says so before it shows the figures.
 */
function DryRunCard({ dryRun, currency }: { dryRun: DryRun; currency: string }) {
  const t = useT();
  const { summary, actions } = dryRun;
  return (
    <Card>
      <BlockStack gap="400">
        <SectionHeader title={t("inventory.dryRun.title")} count={actions.length} />
        <Text as="p" tone="subdued">
          {t("inventory.dryRun.help")}
        </Text>
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          <Stat plain size="medium" label={t("inventory.stat.checked")} value={String(summary.productsChecked)} />
          <Stat plain size="medium" label={t("inventory.stat.suppliersRefreshed")} value={String(summary.suppliersRefreshed)} />
          <Stat plain size="medium" label={t("inventory.runs.suppliersFailed")} value={String(summary.suppliersFailed)} tone={summary.suppliersFailed > 0 ? "critical" : "default"} />
        </InlineGrid>
        {summary.errors.length > 0 && (
          <Banner tone="warning">
            <List>
              {summary.errors.map((error, i) => (
                <List.Item key={i}>{error}</List.Item>
              ))}
            </List>
          </Banner>
        )}
        {actions.length === 0 ? (
          <EmptyScreen compact heading={t("inventory.dryRun.nothing")} body={t("inventory.dryRun.nothingBody")} />
        ) : (
          <DataTable
            columnContentTypes={["text", "text", "numeric", "numeric", "text"]}
            headings={[t("inventory.table.action"), t("inventory.table.variant"), t("inventory.table.newPrice"), t("inventory.table.newQuantity"), t("inventory.table.reason")]}
            rows={actions.slice(0, DRY_RUN_ROWS).map((a) => [
              t(`inventory.actionType.${a.type}` as I18nKey) ?? a.type,
              a.variant.split("/").pop() ?? a.variant,
              a.price === null ? "—" : formatMoney(a.price, currency),
              a.quantity === null ? "—" : a.quantity,
              a.reason,
            ])}
          />
        )}
        {actions.length > DRY_RUN_ROWS && (
          <Text as="p" tone="subdued" variant="bodySm">
            {t("inventory.dryRun.truncated", { n: DRY_RUN_ROWS, total: actions.length })}
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}

function formatDuration(startedAt: string | null, finishedAt: string | null, t: ReturnType<typeof useT>): string {
  if (!startedAt || !finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? t("inventory.runs.seconds", { n: seconds }) : t("inventory.runs.minutes", { n: Math.round(seconds / 60) });
}
