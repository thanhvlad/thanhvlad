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
import { formatMoney } from "~/lib/format";
import { applyPricingRuleToImport, listImportList, removeFromImportList, summarizeMargins, addToImportList } from "~/services/import.server";
import { createJobRun } from "~/services/jobs.server";
import { enqueue } from "~/services/jobs/index.server";
import { listPricingRules } from "~/services/pricing.server";
import type { ImportStatus } from "@prisma/client";

const TABS: Array<{ id: ImportStatus | "ALL"; label: string }> = [
  { id: "ALL", label: "All" },
  { id: "DRAFT", label: "Draft" },
  { id: "FAILED", label: "Failed" },
  { id: "PUSHED", label: "Pushed" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") ?? "ALL") as ImportStatus | "ALL";
  const search = url.searchParams.get("q") ?? "";
  const page = Number(url.searchParams.get("page") ?? 1);
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
        return { ok: true, message: `${count} product(s) removed.` };
      }
      case "apply-rule": {
        const ruleId = get("ruleId") || null;
        for (const id of ids) await applyPricingRuleToImport(shop.id, id, ruleId);
        return { ok: true, message: `Pricing rule applied to ${ids.length} product(s).` };
      }
      case "add": {
        const product = await addToImportList(shop, get("reference"), { actor });
        return { ok: true, message: `"${product.title}" added.` };
      }
      case "import-csv": {
        const text = get("csv");
        const refs = text
          .split(/\r?\n/)
          .map((line) => line.split(",")[0]?.trim())
          .filter((v): v is string => Boolean(v) && !/^(url|link|product)/i.test(v));
        let ok = 0;
        const errors: string[] = [];
        for (const ref of refs.slice(0, 200)) {
          try {
            await addToImportList(shop, ref, { actor });
            ok += 1;
          } catch (e) {
            errors.push(`${ref}: ${errorMessage(e)}`);
          }
        }
        return { ok: true, message: `${ok} product(s) imported from CSV${errors.length ? `, ${errors.length} failed` : ""}.`, errors };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function ImportListPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(data.search);
  const [ruleId, setRuleId] = useState(data.rules.find((r) => r.isDefault)?.id ?? "");
  const [reference, setReference] = useState("");
  const [csv, setCsv] = useState("");
  const [jobRunId, setJobRunId] = useState<string | null>(null);

  const items = data.list.items;
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(items);
  const selectedIndex = TABS.findIndex((t) => t.id === data.status);

  const submit = (intent: string, extra: Record<string, string> = {}) => {
    fetcher.submit({ intent, ids: selectedResources.join(","), ...extra }, { method: "post" });
  };

  if (fetcher.data && "jobRunId" in fetcher.data && fetcher.data.jobRunId && fetcher.data.jobRunId !== jobRunId) {
    setJobRunId(fetcher.data.jobRunId);
    clearSelection();
  }

  return (
    <Page
      title="Import list"
      subtitle="Review and edit products before they go to your store."
      primaryAction={{ content: "Push selected to Shopify", disabled: selectedResources.length === 0, onAction: () => submit("push"), loading: fetcher.state !== "idle" }}
      secondaryActions={[{ content: "Find products", url: "/app/search" }]}
    >
      <Layout>
        <Layout.Section>
          <JobProgress jobRunId={jobRunId} onDone={() => setJobRunId(null)} />
          {fetcher.data && "message" in fetcher.data && fetcher.data.message && (
            <Banner tone="success" onDismiss={() => undefined}>
              <p>{fetcher.data.message}</p>
              {"errors" in fetcher.data && fetcher.data.errors?.length ? (
                <BlockStack gap="100">
                  {fetcher.data.errors.slice(0, 10).map((e) => (
                    <Text as="p" key={e} tone="critical">
                      {e}
                    </Text>
                  ))}
                </BlockStack>
              ) : null}
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
              tabs={TABS.map((t) => ({ id: t.id, content: t.id === "ALL" ? `All (${Object.values(data.list.counts).reduce((a, b) => a + (b ?? 0), 0)})` : `${t.label} (${data.list.counts[t.id as ImportStatus] ?? 0})` }))}
              selected={selectedIndex < 0 ? 0 : selectedIndex}
              onSelect={(i) => {
                const sp = new URLSearchParams(params);
                sp.set("status", TABS[i].id);
                sp.delete("page");
                navigate(`?${sp.toString()}`);
              }}
            />
            <div style={{ padding: "var(--p-space-300)" }}>
              <InlineStack gap="300" blockAlign="end" wrap>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <TextField
                    label="Search"
                    labelHidden
                    value={search}
                    onChange={setSearch}
                    autoComplete="off"
                    placeholder="Search import list"
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
                        Search
                      </Button>
                    }
                  />
                </div>
                <Select label="Pricing rule" labelHidden options={[{ label: "Built-in default rule", value: "" }, ...data.rules.map((r) => ({ label: r.name, value: r.id }))]} value={ruleId} onChange={setRuleId} />
                <Button disabled={selectedResources.length === 0} onClick={() => submit("apply-rule", { ruleId })}>
                  Apply rule
                </Button>
                <Button tone="critical" disabled={selectedResources.length === 0} onClick={() => submit("remove")}>
                  Remove
                </Button>
              </InlineStack>
            </div>
            {items.length === 0 ? (
              <EmptyState heading="Your import list is empty" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png" action={{ content: "Find products", url: "/app/search" }}>
                <p>Search a supplier or paste product links to get started.</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={{ singular: "product", plural: "products" }}
                itemCount={items.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[{ title: "Product" }, { title: "Supplier" }, { title: "Variants" }, { title: "Cost" }, { title: "Price" }, { title: "Margin" }, { title: "Status" }]}
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
                        {!item.available && <Badge tone="critical">Unavailable</Badge>}
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
                Add by link
              </Text>
              <TextField label="Product URL or ID" labelHidden value={reference} onChange={setReference} autoComplete="off" placeholder="https://www.aliexpress.com/item/1005006001.html" />
              <Button onClick={() => fetcher.submit({ intent: "add", reference }, { method: "post" })} disabled={!reference.trim()} loading={fetcher.state !== "idle"}>
                Add to import list
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Bulk import from CSV
              </Text>
              <Text as="p" tone="subdued">
                Paste CSV rows; the first column must be the product URL or ID. Up to 200 rows per batch.
              </Text>
              <TextField label="CSV" labelHidden multiline={4} value={csv} onChange={setCsv} autoComplete="off" placeholder={"url\nhttps://www.aliexpress.com/item/1005006001.html\n1005006002"} />
              <Button onClick={() => fetcher.submit({ intent: "import-csv", csv }, { method: "post" })} disabled={!csv.trim()} loading={fetcher.state !== "idle"}>
                Import CSV
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
