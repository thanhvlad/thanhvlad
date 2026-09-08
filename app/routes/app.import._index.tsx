import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Layout,
  Page,
  Select,
  Tabs,
  Text,
  TextField,
  useIndexResourceState,
} from "@shopify/polaris";
import { JobProgress } from "~/components/JobProgress";
import { Paginator } from "~/components/Paginator";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney, pageParam } from "~/lib/format";
import { useJobRun } from "~/lib/use-job-run";
import { useMessage, useT } from "~/lib/use-t";
import { applyPricingRuleToImport, listImportList, removeFromImportList, summarizeMargins, addToImportList } from "~/services/import.server";
import { createJobRun } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { listPricingRules } from "~/services/pricing.server";
import type { ImportStatus } from "@prisma/client";

/** Rows accepted per CSV paste. Anything past this is reported, not dropped. */
const MAX_CSV_ROWS = 500;

const TABS: Array<ImportStatus | "ALL"> = ["ALL", "DRAFT", "FAILED", "PUSHED"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "ALL") as ImportStatus | "ALL";
  const search = url.searchParams.get("q") ?? "";
  const page = pageParam(url.searchParams.get("page"));
  const [list, rules] = await Promise.all([listImportList(shop.id, { status, search, page, pageSize: 25 }), listPricingRules(shop.id)]);
  return {
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
    return { ok: false, error: errorMessage(e) };
  }
};

export default function ImportListPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const actionMessage = useMessage(fetcher.data as Parameters<typeof useMessage>[0]);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(data.search);
  const [ruleId, setRuleId] = useState(data.rules.find((r) => r.isDefault)?.id ?? "");
  const [reference, setReference] = useState("");
  const [csv, setCsv] = useState("");
  const items = data.list.items;
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(items);
  const selectedIndex = TABS.findIndex((id) => id === data.status);
  const { jobRunId, clearJobRun } = useJobRun(fetcher.data, clearSelection);

  const tabLabel = (id: ImportStatus | "ALL") =>
    id === "DRAFT" ? t("import.tab.draft") : id === "FAILED" ? t("import.tab.failed") : id === "PUSHED" ? t("import.tab.pushed") : t("common.all");

  const submit = (intent: string, extra: Record<string, string> = {}) => {
    fetcher.submit({ intent, ids: selectedResources.join(","), ...extra }, { method: "post" });
  };

  return (
    <Page
      title={t("page.import.title")}
      subtitle={t("page.import.subtitle")}
      primaryAction={{ content: t("import.pushSelected"), disabled: selectedResources.length === 0, onAction: () => submit("push"), loading: fetcher.state !== "idle" }}
      secondaryActions={[{ content: t("nav.search"), url: "/app/search" }]}
    >
      <Layout>
        <Layout.Section>
          <JobProgress jobRunId={jobRunId} onDone={clearJobRun} />
          {actionMessage && (
            <Banner tone="success">
              <p>{actionMessage}</p>
            </Banner>
          )}
          {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
            <Banner tone="critical">
              <p>{fetcher.data.error}</p>
            </Banner>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Tabs
              tabs={TABS.map((id) => ({
                id,
                content:
                  id === "ALL"
                    ? `${t("common.all")} (${Object.values(data.list.counts).reduce((a, b) => a + (b ?? 0), 0)})`
                    : `${tabLabel(id)} (${data.list.counts[id as ImportStatus] ?? 0})`,
              }))}
              selected={selectedIndex < 0 ? 0 : selectedIndex}
              onSelect={(i) => {
                const sp = new URLSearchParams(params);
                sp.set("status", TABS[i]);
                sp.delete("page");
                navigate(`?${sp.toString()}`);
              }}
            />
            <div style={{ padding: "var(--p-space-300)" }}>
              <InlineStack gap="300" blockAlign="end" wrap>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <TextField
                    label={t("action.search")}
                    labelHidden
                    value={search}
                    onChange={setSearch}
                    autoComplete="off"
                    placeholder={t("import.searchPlaceholder")}
                    onClearButtonClick={() => {
                      setSearch("");
                      navigate("?");
                    }}
                    clearButton
                    connectedRight={
                      <Button
                        onClick={() => {
                          const sp = new URLSearchParams(params);
                          if (search) sp.set("q", search);
                          else sp.delete("q");
                          sp.delete("page");
                          navigate(`?${sp.toString()}`);
                        }}
                      >
                        {t("action.search")}
                      </Button>
                    }
                  />
                </div>
                <Select
                  label={t("import.pricingRule")}
                  labelHidden
                  options={[{ label: t("import.builtInDefaultRule"), value: "" }, ...data.rules.map((r) => ({ label: r.name, value: r.id }))]}
                  value={ruleId}
                  onChange={setRuleId}
                />
                <Button disabled={selectedResources.length === 0} onClick={() => submit("apply-rule", { ruleId })}>
                  {t("import.applyRule")}
                </Button>
                <Button tone="critical" disabled={selectedResources.length === 0} onClick={() => submit("remove")}>
                  {t("action.remove")}
                </Button>
              </InlineStack>
            </div>
            {items.length === 0 ? (
              <EmptyState
                heading={t("import.empty.heading")}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{ content: t("nav.search"), url: "/app/search" }}
              >
                <p>{t("import.empty.body")}</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: t("import.resource.singular"), plural: t("import.resource.plural") }}
                itemCount={items.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[
                  { title: t("import.column.product") },
                  { title: t("common.supplier") },
                  { title: t("common.variants") },
                  { title: t("common.cost") },
                  { title: t("common.price") },
                  { title: t("import.margin") },
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
                          {item.pushError && (
                            <Text as="span" tone="critical" variant="bodySm">
                              {item.pushError}
                            </Text>
                          )}
                        </BlockStack>
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <PlatformBadge platform={item.platform} />
                        {item.storeName && (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {item.storeName}
                          </Text>
                        )}
                        {!item.available && <Badge tone="critical">{t("import.unavailable")}</Badge>}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{item.variantCount}</IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(item.margins.minCost, data.currency)}
                      {item.margins.minCost !== item.margins.maxCost ? ` – ${formatMoney(item.margins.maxCost, data.currency)}` : ""}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {formatMoney(item.margins.minPrice, data.currency)}
                      {item.margins.minPrice !== item.margins.maxPrice ? ` – ${formatMoney(item.margins.maxPrice, data.currency)}` : ""}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{item.margins.avgMargin}%</IndexTable.Cell>
                    <IndexTable.Cell>
                      {item.status === "PUSHED" && item.pushedProductId ? (
                        <Link to={`/app/products/${item.pushedProductId}`}>
                          <StatusBadge status={item.status} />
                        </Link>
                      ) : (
                        <StatusBadge status={item.status} />
                      )}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
            <div style={{ padding: "var(--p-space-300)" }}>
              <Paginator page={data.list.page} pageSize={data.list.pageSize} total={data.list.total} />
            </div>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("import.addByLink")}
              </Text>
              <TextField label={t("import.productUrlOrId")} labelHidden value={reference} onChange={setReference} autoComplete="off" placeholder="https://www.aliexpress.com/item/1005006001.html" />
              <Button onClick={() => fetcher.submit({ intent: "add", reference }, { method: "post" })} disabled={!reference.trim()} loading={fetcher.state !== "idle"}>
                {t("action.addToImport")}
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("import.bulkCsv.title")}
              </Text>
              <Text as="p" tone="subdued">
                {t("import.bulkCsv.help")}
              </Text>
              <TextField label={t("import.bulkCsv.field")} labelHidden multiline={4} value={csv} onChange={setCsv} autoComplete="off" placeholder={"url\nhttps://www.aliexpress.com/item/1005006001.html\n1005006002"} />
              <Button onClick={() => fetcher.submit({ intent: "import-csv", csv }, { method: "post" })} disabled={!csv.trim()} loading={fetcher.state !== "idle"}>
                {t("import.bulkCsv.action")}
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
