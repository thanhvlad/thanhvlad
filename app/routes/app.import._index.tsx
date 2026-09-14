import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
  useIndexResourceState,
} from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { MarginText } from "~/components/import-margin";
import { JobProgress } from "~/components/JobProgress";
import { Paginator } from "~/components/Paginator";
import { SectionHeader } from "~/components/SectionHeader";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import { MAX_AI_REWRITE_BATCH, PLANS, aiUsageResetsAt, checkAiRewriteRequest, type AiRewriteRefusal } from "~/domain/billing/plans";
import { readForm, requireShop } from "~/lib/auth.server";
import { aiEndpointStatus, aiLandingAvailable } from "~/services/ai-landing.server";
import { actionFailure, errorMessage } from "~/lib/errors";
import { formatMoney, pageParam } from "~/lib/format";
import type { I18nKey } from "~/lib/i18n";
import { logger } from "~/lib/logger.server";
import { useJobRun } from "~/lib/use-job-run";
import { useErrorMessage, useLocale, useMessage, useT } from "~/lib/use-t";
import { applyPricingRuleToImport, listImportList, removeFromImportList, summarizeMargins, addToImportList } from "~/services/import.server";
import { getAiRewriteAllowance } from "~/services/landing-rewrite.server";
import { createJobRun } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { listPricingRules } from "~/services/pricing.server";
import type { ImportStatus } from "@prisma/client";

/** Rows accepted per CSV paste. Anything past this is reported, not dropped. */
const MAX_CSV_ROWS = 500;

const TABS: Array<ImportStatus | "ALL"> = ["ALL", "DRAFT", "FAILED", "PUSHED"];

/** Intents that act on the selected rows, so the table shows the wait. */
const BULK_INTENTS = new Set(["push", "rewrite", "remove", "apply-rule"]);

/** Why a rewrite batch was refused, in the merchant's language. */
const REWRITE_REFUSAL_KEYS: Record<AiRewriteRefusal, I18nKey> = {
  "none-selected": "import.list.rewrite.refused.noneSelected",
  "batch-too-large": "import.list.rewrite.refused.batchTooLarge",
  "quota-exhausted": "import.list.rewrite.refused.quotaExhausted",
  "quota-short": "import.list.rewrite.refused.quotaShort",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "ALL") as ImportStatus | "ALL";
  const search = url.searchParams.get("q") ?? "";
  const page = pageParam(url.searchParams.get("page"));
  const available = aiLandingAvailable();
  const [list, rules, allowance] = await Promise.all([
    listImportList(shop.id, { status, search, page, pageSize: 25 }),
    listPricingRules(shop.id),
    // The list must still open if the allowance cannot be read (say, the usage
    // table has not been migrated yet); the rewrite is then simply not offered.
    available
      ? getAiRewriteAllowance(shop).catch((error: unknown) => {
          logger.warn("Could not read the AI rewrite allowance", { shopId: shop.id, error: errorMessage(error) });
          return null;
        })
      : Promise.resolve(null),
  ]);
  return {
    // Without a key the rewrite cannot run, so the action is not offered at all
    // rather than offered and answered with an environment-variable error.
    ai: allowance
      ? {
          ...allowance,
          planName: PLANS[allowance.plan].displayName,
          upgradeName: allowance.upgradeTo ? PLANS[allowance.upgradeTo].displayName : null,
          resetsAt: aiUsageResetsAt().toISOString(),
          viaGateway: !aiEndpointStatus().direct,
        }
      : null,
    currency: shop.currency,
    status,
    search,
    list: {
      ...list,
      items: list.items.map((p) => ({
        id: p.id,
        title: p.title,
        image: p.images[0] ?? null,
        status: p.status,
        pushError: p.pushError,
        pushedProductId: p.pushedProductId,
        variantCount: p.variants.length,
        platform: p.supplierProduct?.platform ?? "MANUAL",
        storeName: p.supplierProduct?.storeName ?? null,
        supplierUrl: p.supplierProduct?.url ?? null,
        available: p.supplierProduct?.isAvailable ?? true,
        margins: summarizeMargins(p.variants),
        createdAt: p.createdAt,
      })),
    },
    rules: rules.map((r) => ({ id: r.id, name: r.name, isDefault: r.isDefault })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, actor } = await requireShop(request);
  const { intent, get, getAll } = await readForm(request);
  const ids = getAll("ids").flatMap((v) => v.split(",")).filter(Boolean);

  try {
    switch (intent) {
      case "push": {
        if (ids.length === 0) return { ok: false, error: "Select at least one product." };
        const job = await createJobRun({ shopId: shop.id, type: "push-products", total: ids.length, payload: { ids } });
        await enqueue("push-products", { shopId: shop.id, importedProductIds: ids, jobRunId: job.id, actor });
        return { ok: true, jobRunId: job.id };
      }
      case "rewrite": {
        if (!aiLandingAvailable()) return { ok: false, error: "AI rewrite is not available.", errorKey: "import.list.rewrite.unavailable" };
        // The confirmation is where the merchant is told their product data
        // goes to an AI provider and that each product uses an allowance. A
        // request that did not come through it has not been told either.
        if (get("disclosed") !== "yes") return { ok: false, error: "Confirm the AI rewrite first.", errorKey: "import.list.rewrite.notConfirmed" };
        const allowance = await getAiRewriteAllowance(shop);
        const refusal = checkAiRewriteRequest(allowance, ids.length);
        if (refusal) {
          return {
            ok: false,
            error: `AI rewrite refused: ${refusal}.`,
            errorKey: REWRITE_REFUSAL_KEYS[refusal],
            errorVars: { n: ids.length, max: MAX_AI_REWRITE_BATCH, remaining: allowance.remaining ?? "", limit: allowance.limit ?? "", plan: PLANS[allowance.plan].displayName },
          };
        }
        const job = await createJobRun({ shopId: shop.id, type: "rewrite-landing", total: ids.length, payload: { ids } });
        await enqueue("rewrite-landing", { shopId: shop.id, importedProductIds: ids, jobRunId: job.id, actor, pushAfter: true });
        return { ok: true, jobRunId: job.id };
      }
      case "remove": {
        const count = await removeFromImportList(shop.id, ids);
        return { ok: true, messageKey: "msg.productsRemoved", messageVars: { n: count } };
      }
      case "apply-rule": {
        const ruleId = get("ruleId") || null;
        for (const id of ids) await applyPricingRuleToImport(shop.id, id, ruleId);
        return { ok: true, messageKey: "msg.pricingRuleAppliedTo", messageVars: { n: ids.length } };
      }
      case "add": {
        const product = await addToImportList(shop, get("reference"), { actor });
        return { ok: true, messageKey: "msg.productAdded", messageVars: { title: product.title } };
      }
      case "import-csv": {
        const text = get("csv");
        const refs = text
          .split(/\r?\n/)
          .map((line) => line.split(",")[0]?.trim())
          .filter((v): v is string => Boolean(v) && !/^(url|link|product)/i.test(v));
        if (refs.length === 0) return { ok: false, error: "No product links or ids found in that CSV." };
        // Every reference is a supplier round trip, so this goes through the
        // queue like every other bulk action rather than holding the request
        // open for minutes and dying at the platform timeout.
        const batch = refs.slice(0, MAX_CSV_ROWS);
        const job = await createJobRun({ shopId: shop.id, type: "import-references", total: batch.length, payload: { references: batch } });
        await enqueue("import-references", { shopId: shop.id, references: batch, jobRunId: job.id, actor });
        return {
          ok: true,
          jobRunId: job.id,
          message:
            refs.length > batch.length
              ? `Importing the first ${batch.length} of ${refs.length} rows; re-paste the rest afterwards.`
              : `Importing ${batch.length} product(s) in the background.`,
        };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return actionFailure(e);
  }
};

type ModalName = "add" | "rule" | "remove" | "rewrite";

export default function ImportListPage() {
  const t = useT();
  const locale = useLocale();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const actionMessage = useMessage(fetcher.data as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(fetcher.data as Parameters<typeof useErrorMessage>[0]);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(data.search);
  const [ruleId, setRuleId] = useState(data.rules.find((r) => r.isDefault)?.id ?? "");
  const [reference, setReference] = useState("");
  const [csv, setCsv] = useState("");
  const [modal, setModal] = useState<ModalName | null>(null);
  const [lastIntent, setLastIntent] = useState("");
  const items = data.list.items;
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(items);
  const selectedIndex = TABS.findIndex((id) => id === data.status);
  const { jobRunId, clearJobRun } = useJobRun(fetcher.data, clearSelection);

  const busy = fetcher.state !== "idle";
  const pendingIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const selectedCount = selectedResources.length;

  // The list hides archived products, so the "All" count must too — otherwise
  // the tab promises more rows than it shows.
  const counts = data.list.counts;
  const allCount = (Object.keys(counts) as ImportStatus[]).filter((s) => s !== "ARCHIVED").reduce((sum, s) => sum + (counts[s] ?? 0), 0);

  // A modal launched the submission; close it once the server says yes, and
  // clear the field that was just consumed. `fetcher.data` only changes per
  // submission, so this runs once per outcome and not on every render.
  const clearSelectionRef = useRef(clearSelection);
  clearSelectionRef.current = clearSelection;
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !fetcher.data.ok) return;
    setModal(null);
    if (lastIntent === "add") setReference("");
    if (lastIntent === "import-csv") setCsv("");
    if (lastIntent === "remove" || lastIntent === "apply-rule") clearSelectionRef.current();
  }, [fetcher.state, fetcher.data, lastIntent]);

  const submit = (intent: string, extra: Record<string, string> = {}) => {
    setLastIntent(intent);
    fetcher.submit({ intent, ids: selectedResources.join(","), ...extra }, { method: "post" });
  };
  const submitForm = (intent: string, fields: Record<string, string>) => {
    setLastIntent(intent);
    fetcher.submit({ intent, ...fields }, { method: "post" });
  };

  const applySearch = (value: string) => {
    const sp = new URLSearchParams(params);
    if (value) sp.set("q", value);
    else sp.delete("q");
    sp.delete("page");
    navigate(`?${sp.toString()}`);
  };

  const tabLabel = (id: ImportStatus | "ALL") =>
    id === "DRAFT" ? t("import.tab.draft") : id === "FAILED" ? t("import.tab.failed") : id === "PUSHED" ? t("import.tab.pushed") : t("common.all");
  const tabCount = (id: ImportStatus | "ALL") => (id === "ALL" ? allCount : (counts[id] ?? 0));

  // A message that arrived with a job id announces work that has only started,
  // so it reads as information, not as a result.
  const messageTone = fetcher.data && "jobRunId" in fetcher.data && fetcher.data.jobRunId ? "info" : "success";
  const modalFailure = failureMessage && (lastIntent === "add" || lastIntent === "import-csv" || lastIntent === "rewrite") ? failureMessage : undefined;

  const listIsEmpty = allCount === 0 && !data.search && data.status === "ALL";

  // Checked here as well as on the server so the confirmation can say what is
  // wrong before the merchant presses anything; the server's answer still rules.
  const ai = data.ai;
  const rewriteRefusal = ai ? checkAiRewriteRequest(ai, selectedCount) : null;
  const resetsOn = ai ? new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(ai.resetsAt)) : "";

  const table = (
    <IndexTable
      resourceName={{ singular: t("import.resource.singular"), plural: t("import.resource.plural") }}
      itemCount={items.length}
      selectedItemsCount={allResourcesSelected ? "All" : selectedCount}
      onSelectionChange={handleSelectionChange}
      loading={busy && BULK_INTENTS.has(pendingIntent)}
      promotedBulkActions={[
        { content: t("import.list.bulk.push"), onAction: () => submit("push"), disabled: busy },
        // Rewrites and publishes in one go: the merchant has already decided
        // what the finished form looks like, so a review step in between
        // would only be a step. It spends money and sends product data to an
        // AI provider, though, so it goes through a confirmation that says so
        // and shows what is left of the month's allowance. A store exempt from
        // the allowance has no count worth showing on the button.
        ...(ai
          ? [
              {
                content: ai.remaining === null ? t("import.list.bulk.rewrite") : t("import.list.bulk.rewriteLeft", { n: ai.remaining }),
                onAction: () => setModal("rewrite"),
                disabled: busy,
              },
            ]
          : []),
        { content: t("action.remove"), onAction: () => setModal("remove"), disabled: busy },
      ]}
      bulkActions={[{ content: t("import.list.bulk.applyRule"), onAction: () => setModal("rule"), disabled: busy }]}
      headings={[
        { title: t("import.column.product") },
        { title: t("common.variants"), alignment: "end" },
        { title: t("common.cost"), alignment: "end" },
        { title: t("common.price"), alignment: "end" },
        { title: t("import.margin"), alignment: "end" },
        { title: t("common.status") },
      ]}
    >
      {items.map((item, index) => (
        <IndexTable.Row id={item.id} key={item.id} position={index} selected={selectedResources.includes(item.id)}>
          <IndexTable.Cell>
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <Thumb src={item.image} alt={item.title} />
              <BlockStack gap="050">
                <Link to={`/app/import/${item.id}`}>
                  <Text as="span" fontWeight="semibold">
                    {item.title}
                  </Text>
                </Link>
                <InlineStack gap="200" blockAlign="center">
                  {/* The badge is not an alternative to the store name: a row
                      with a store name was left with no way to tell which
                      platform it came from without opening it. */}
                  {item.platform === "MANUAL" ? (
                    <Text as="span" tone="subdued" variant="bodySm">
                      {t("import.list.notLinked")}
                    </Text>
                  ) : (
                    <PlatformBadge platform={item.platform} />
                  )}
                  {item.storeName && (
                    <Text as="span" tone="subdued" variant="bodySm">
                      {item.storeName}
                    </Text>
                  )}
                  {!item.available && <Badge tone="critical">{t("import.unavailable")}</Badge>}
                </InlineStack>
                {item.pushError && (
                  <Text as="span" tone="critical" variant="bodySm">
                    {item.pushError}
                  </Text>
                )}
              </BlockStack>
            </InlineStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="p" alignment="end" numeric>
              {item.variantCount}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="p" alignment="end" numeric>
              {moneyRange(item.margins.minCost, item.margins.maxCost, data.currency)}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="p" alignment="end" numeric>
              {moneyRange(item.margins.minPrice, item.margins.maxPrice, data.currency)}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <MarginText value={item.margins.avgMargin} />
          </IndexTable.Cell>
          <IndexTable.Cell>
            {item.status === "PUSHED" && item.pushedProductId ? (
              // The one sanctioned inline style: the anchor's underline runs
              // under the badge and makes it look struck through.
              <Link to={`/app/products/${item.pushedProductId}`} style={{ textDecoration: "none" }}>
                <StatusBadge status={item.status} />
              </Link>
            ) : (
              <StatusBadge status={item.status} />
            )}
          </IndexTable.Cell>
        </IndexTable.Row>
      ))}
    </IndexTable>
  );

  return (
    <Page
      fullWidth
      title={t("page.import.title")}
      subtitle={t("page.import.subtitle")}
      primaryAction={{ content: t("import.list.addProducts"), onAction: () => setModal("add") }}
      secondaryActions={[{ content: t("nav.search"), url: "/app/search" }]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
            <JobProgress jobRunId={jobRunId} onDone={clearJobRun} />
            {actionMessage && (
              <Banner tone={messageTone}>
                <p>{actionMessage}</p>
              </Banner>
            )}
            {failureMessage && !modalFailure && (
              <Banner tone="critical">
                <p>{failureMessage}</p>
              </Banner>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          {listIsEmpty ? (
            <EmptyScreen heading={t("import.empty.heading")} body={t("import.list.empty.body")} action={{ content: t("nav.search"), url: "/app/search" }} />
          ) : (
            <Card padding="0">
              <Tabs
                tabs={TABS.map((id) => ({ id, content: `${tabLabel(id)} (${tabCount(id)})` }))}
                selected={selectedIndex < 0 ? 0 : selectedIndex}
                onSelect={(i) => {
                  const sp = new URLSearchParams(params);
                  sp.set("status", TABS[i]);
                  sp.delete("page");
                  navigate(`?${sp.toString()}`);
                }}
              />
              <Box padding="300">
                <TextField
                  label={t("action.search")}
                  labelHidden
                  value={search}
                  onChange={setSearch}
                  autoComplete="off"
                  placeholder={t("import.searchPlaceholder")}
                  clearButton
                  onClearButtonClick={() => {
                    setSearch("");
                    applySearch("");
                  }}
                  connectedRight={<Button onClick={() => applySearch(search)}>{t("action.search")}</Button>}
                />
              </Box>
              {items.length === 0 ? (
                data.search ? (
                  <EmptyScreen
                    compact
                    heading={t("import.list.noMatch.heading", { q: data.search })}
                    body={t("import.list.noMatch.body")}
                    action={{
                      content: t("import.list.clearSearch"),
                      onAction: () => {
                        setSearch("");
                        applySearch("");
                      },
                    }}
                  />
                ) : (
                  <EmptyScreen
                    compact
                    heading={t("import.list.emptyTab.heading")}
                    body={t("import.list.emptyTab.body")}
                    action={{ content: t("common.viewAll"), url: "/app/import" }}
                  />
                )
              ) : (
                table
              )}
              <Box padding="300">
                <Paginator page={data.list.page} pageSize={data.list.pageSize} total={data.list.total} />
              </Box>
            </Card>
          )}
        </Layout.Section>
      </Layout>

      <Modal open={modal === "add"} onClose={() => setModal(null)} title={t("import.list.addModal.title")}>
        {modalFailure && (
          <Modal.Section>
            <Banner tone="critical">
              <p>{modalFailure}</p>
            </Banner>
          </Modal.Section>
        )}
        <Modal.Section>
          <BlockStack gap="300">
            <SectionHeader title={t("import.addByLink")} />
            <TextField
              label={t("import.productUrlOrId")}
              value={reference}
              onChange={setReference}
              autoComplete="off"
              placeholder={t("import.list.linkPlaceholder")}
              helpText={t("import.list.addByLink.help")}
            />
            <InlineStack align="end">
              <Button onClick={() => submitForm("add", { reference })} disabled={!reference.trim() || busy} loading={pendingIntent === "add"}>
                {t("action.addToImport")}
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
        <Modal.Section>
          <BlockStack gap="300">
            <SectionHeader title={t("import.bulkCsv.title")} />
            <TextField
              label={t("import.bulkCsv.field")}
              labelHidden
              multiline={4}
              value={csv}
              onChange={setCsv}
              autoComplete="off"
              placeholder={t("import.list.csvPlaceholder")}
              helpText={t("import.bulkCsv.help")}
            />
            <InlineStack align="end">
              <Button onClick={() => submitForm("import-csv", { csv })} disabled={!csv.trim() || busy} loading={pendingIntent === "import-csv"}>
                {t("import.bulkCsv.action")}
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={modal === "rule"}
        onClose={() => setModal(null)}
        title={t("import.list.applyRuleModal.title", { n: selectedCount })}
        primaryAction={{ content: t("import.applyRule"), onAction: () => submit("apply-rule", { ruleId }), loading: pendingIntent === "apply-rule", disabled: selectedCount === 0 }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setModal(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Select
              label={t("import.pricingRule")}
              options={[{ label: t("import.builtInDefaultRule"), value: "" }, ...data.rules.map((r) => ({ label: r.name, value: r.id }))]}
              value={ruleId}
              onChange={setRuleId}
            />
            <Text as="p" tone="subdued">
              {t("import.list.applyRuleModal.help")}
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {ai && (
        <Modal
          open={modal === "rewrite"}
          onClose={() => setModal(null)}
          title={t("import.list.rewriteModal.title", { n: selectedCount })}
          primaryAction={{
            content: t("import.list.rewriteModal.confirm", { n: selectedCount }),
            onAction: () => submit("rewrite", { disclosed: "yes" }),
            loading: pendingIntent === "rewrite",
            disabled: rewriteRefusal !== null,
          }}
          secondaryActions={[{ content: t("action.cancel"), onAction: () => setModal(null) }]}
        >
          {modalFailure && lastIntent === "rewrite" && (
            <Modal.Section>
              <Banner tone="critical">
                <p>{modalFailure}</p>
              </Banner>
            </Modal.Section>
          )}
          {rewriteRefusal && (
            <Modal.Section>
              <Banner tone="warning">
                <p>
                  {t(REWRITE_REFUSAL_KEYS[rewriteRefusal], { n: selectedCount, max: MAX_AI_REWRITE_BATCH, remaining: ai.remaining ?? "", limit: ai.limit ?? "", plan: ai.planName })}
                  {ai.upgradeName && (rewriteRefusal === "quota-exhausted" || rewriteRefusal === "quota-short") ? ` ${t("import.list.rewrite.upgradeHint", { upgrade: ai.upgradeName })}` : ""}
                </p>
              </Banner>
            </Modal.Section>
          )}
          <Modal.Section>
            <BlockStack gap="300">
              <SectionHeader title={t("import.list.rewriteModal.dataTitle")} />
              <Text as="p">{t("import.list.rewriteModal.dataBody")}</Text>
              {ai.viaGateway && <Text as="p">{t("import.list.rewriteModal.gateway")}</Text>}
              <Text as="p">{t("import.list.rewriteModal.publish")}</Text>
            </BlockStack>
          </Modal.Section>
          <Modal.Section>
            <BlockStack gap="200">
              <SectionHeader title={t("import.list.rewriteModal.allowanceTitle")} />
              {ai.remaining === null || ai.limit === null ? (
                <>
                  <Text as="p">{t("import.list.rewriteModal.allowanceUnlimited")}</Text>
                  <Text as="p" tone="subdued">
                    {t("import.list.rewriteModal.allowanceUnlimitedHelp", { max: MAX_AI_REWRITE_BATCH })}
                  </Text>
                </>
              ) : (
                <>
                  <Text as="p" numeric>
                    {t("import.list.rewriteModal.allowance", { remaining: ai.remaining, limit: ai.limit, plan: ai.planName })}
                  </Text>
                  <Text as="p" tone="subdued">
                    {t("import.list.rewriteModal.allowanceHelp", { date: resetsOn })}
                  </Text>
                </>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}

      <Modal
        open={modal === "remove"}
        onClose={() => setModal(null)}
        title={t("import.list.removeModal.title", { n: selectedCount })}
        primaryAction={{ content: t("action.remove"), destructive: true, onAction: () => submit("remove"), loading: pendingIntent === "remove", disabled: selectedCount === 0 }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setModal(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t("import.list.removeModal.body")}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

/** "$1.00 – $3.00", or a single figure when every variant costs the same. */
function moneyRange(min: string, max: string, currency: string) {
  return min === max ? formatMoney(min, currency) : `${formatMoney(min, currency)} – ${formatMoney(max, currency)}`;
}
