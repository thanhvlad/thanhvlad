import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, Card, Checkbox, DataTable, FormLayout, IndexTable, InlineGrid, InlineStack, Layout, Modal, Page, Select, Text, TextField, useIndexResourceState } from "@shopify/polaris";
import prisma from "~/db.server";
import { EmptyScreen } from "~/components/EmptyScreen";
import { Stat } from "~/components/Stat";
import { StatusBadge } from "~/components/StatusBadge";
import type { PriceOp, PricingRuleInput } from "~/domain/pricing/types";
import { computePrice } from "~/domain/pricing/engine";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney } from "~/lib/format";
import type { Translator } from "~/lib/i18n";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
import { createPricingRule, deletePricingRule, listPricingRules, setDefaultPricingRule, toRuleInput, updatePricingRule, type PricingRuleFormInput } from "~/services/pricing.server";

const opOptions = (t: Translator): Array<{ label: string; value: PriceOp }> => [
  { label: t("pricing.op.multiply"), value: "MULTIPLY" },
  { label: t("pricing.op.add"), value: "ADD" },
  { label: t("pricing.op.margin"), value: "MARGIN" },
  { label: t("pricing.op.fixed"), value: "FIXED" },
  { label: t("pricing.op.none"), value: "NONE" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  // How many imported products each rule prices — the "applies to" column.
  const [rules, usage] = await Promise.all([
    listPricingRules(shop.id),
    prisma.importedProduct.groupBy({ by: ["pricingRuleId"], where: { shopId: shop.id, pricingRuleId: { not: null } }, _count: { _all: true } }),
  ]);
  const productCounts = new Map(usage.map((u) => [u.pricingRuleId, u._count._all]));
  return {
    currency: shop.currency,
    rules: rules.map((r) => ({ ...toRuleInput(r), id: r.id, name: r.name, description: r.description, isDefault: r.isDefault, isEnabled: r.isEnabled, syncCostOfGoods: r.syncCostOfGoods, productCount: productCounts.get(r.id) ?? 0 })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { intent, get, json } = await readForm(request);
  try {
    switch (intent) {
      case "save": {
        const input = json<PricingRuleFormInput>("rule", null as unknown as PricingRuleFormInput);
        if (!input) return { ok: false, error: "Missing rule" };
        const id = get("id");
        if (id) await updatePricingRule(shop.id, id, input);
        else await createPricingRule(shop.id, input);
        return { ok: true, messageKey: "msg.pricingRuleSaved" };
      }
      case "delete":
        await deletePricingRule(shop.id, get("id"));
        return { ok: true, messageKey: "msg.pricingRuleDeleted" };
      case "default":
        await setDefaultPricingRule(shop.id, get("id"));
        return { ok: true, messageKey: "msg.defaultRuleUpdated" };
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

type Rule = SerializeFrom<typeof loader>["rules"][number];
type TierForm = { minCost: string; maxCost: string; priceOp: PriceOp; priceValue: string; compareAtOp: PriceOp; compareAtValue: string };
type RuleForm = {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  isEnabled: boolean;
  basePriceOp: PriceOp;
  basePriceValue: string;
  compareAtOp: PriceOp;
  compareAtValue: string;
  centsEnding: string;
  roundToMultiple: string;
  includeShipping: boolean;
  minPrice: string;
  maxPrice: string;
  syncCostOfGoods: boolean;
  tiers: TierForm[];
};

const EMPTY: RuleForm = {
  id: "", name: "", description: "", isDefault: false, isEnabled: true, basePriceOp: "MULTIPLY", basePriceValue: "2", compareAtOp: "MULTIPLY", compareAtValue: "1.4",
  centsEnding: "99", roundToMultiple: "", includeShipping: false, minPrice: "", maxPrice: "", syncCostOfGoods: true, tiers: [],
};

function toForm(rule: Rule): RuleForm {
  return {
    id: rule.id ?? "",
    name: rule.name ?? "",
    description: rule.description ?? "",
    isDefault: rule.isDefault,
    isEnabled: rule.isEnabled,
    basePriceOp: rule.basePriceOp,
    basePriceValue: String(rule.basePriceValue),
    compareAtOp: rule.compareAtOp ?? "NONE",
    compareAtValue: rule.compareAtValue === null || rule.compareAtValue === undefined ? "" : String(rule.compareAtValue),
    centsEnding: rule.centsEnding === null || rule.centsEnding === undefined ? "" : String(rule.centsEnding),
    roundToMultiple: rule.roundToMultiple === null || rule.roundToMultiple === undefined ? "" : String(rule.roundToMultiple),
    includeShipping: rule.includeShipping ?? false,
    minPrice: rule.minPrice === null || rule.minPrice === undefined ? "" : String(rule.minPrice),
    maxPrice: rule.maxPrice === null || rule.maxPrice === undefined ? "" : String(rule.maxPrice),
    syncCostOfGoods: rule.syncCostOfGoods,
    tiers: (rule.tiers ?? []).map((t) => ({ minCost: String(t.minCost), maxCost: t.maxCost === null || t.maxCost === undefined ? "" : String(t.maxCost), priceOp: t.priceOp, priceValue: String(t.priceValue), compareAtOp: t.compareAtOp ?? "NONE", compareAtValue: t.compareAtValue === null || t.compareAtValue === undefined ? "" : String(t.compareAtValue) })),
  };
}

function toRuleInputFromForm(form: RuleForm): PricingRuleInput {
  return {
    basePriceOp: form.basePriceOp,
    basePriceValue: form.basePriceValue || 0,
    compareAtOp: form.compareAtOp,
    compareAtValue: form.compareAtValue || null,
    centsEnding: form.centsEnding === "" ? null : Number(form.centsEnding),
    roundToMultiple: form.roundToMultiple || null,
    includeShipping: form.includeShipping,
    minPrice: form.minPrice || null,
    maxPrice: form.maxPrice || null,
    tiers: form.tiers.map((t, i) => ({ id: String(i), minCost: t.minCost || 0, maxCost: t.maxCost || null, priceOp: t.priceOp, priceValue: t.priceValue || 0, compareAtOp: t.compareAtOp, compareAtValue: t.compareAtValue || null })),
  };
}

export default function PricingPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const errorText = useErrorMessage(result);
  const busy = fetcher.state !== "idle";
  const pending = (intent: string, id?: string) => busy && fetcher.formData?.get("intent") === intent && (id === undefined || fetcher.formData?.get("id") === id);

  const [form, setForm] = useState<RuleForm | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // A modal stays open while its submit is in flight, so its button can show
  // progress and a failure lands inside the modal rather than behind it. The
  // intent being awaited is remembered; `wasBusy` is what makes the effect wait
  // for the fetcher to have actually started, since the state update and the
  // submit do not always land in the same render.
  const [submitting, setSubmitting] = useState<"save" | "delete" | null>(null);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current || !submitting) return;
    wasBusy.current = false;
    const intent = submitting;
    setSubmitting(null);
    if (intent === "save") {
      if (result?.error) setFormError(result.error);
      else setForm(null);
    } else {
      setDeleting(null);
    }
  }, [busy, submitting, result?.error]);

  const openForm = (next: RuleForm) => {
    setFormError(null);
    setForm(next);
  };
  const closeForm = () => {
    setForm(null);
    setFormError(null);
  };

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } = useIndexResourceState(data.rules);
  const selectedRule = selectedResources.length === 1 ? data.rules.find((r) => r.id === selectedResources[0]) : undefined;

  const opts = opOptions(t);
  const sampleCosts = [1, 2.5, 5, 10, 20, 50, 100];
  const preview = form ? sampleCosts.map((cost) => ({ cost, ...computePrice(toRuleInputFromForm(form), { cost, shippingCost: 2 }) })) : [];
  const defaultRule = data.rules.find((r) => r.isDefault);
  const enabledCount = data.rules.filter((r) => r.isEnabled).length;
  const pricedCount = data.rules.reduce((sum, r) => sum + r.productCount, 0);

  const save = () => {
    if (!form) return;
    const payload: PricingRuleFormInput = {
      name: form.name,
      description: form.description,
      isDefault: form.isDefault,
      isEnabled: form.isEnabled,
      basePriceOp: form.basePriceOp,
      basePriceValue: form.basePriceValue,
      compareAtOp: form.compareAtOp,
      compareAtValue: form.compareAtValue || null,
      centsEnding: form.centsEnding === "" ? null : Number(form.centsEnding),
      roundToMultiple: form.roundToMultiple || null,
      includeShipping: form.includeShipping,
      minPrice: form.minPrice || null,
      maxPrice: form.maxPrice || null,
      syncCostOfGoods: form.syncCostOfGoods,
      tiers: form.tiers.map((t) => ({ minCost: t.minCost, maxCost: t.maxCost || null, priceOp: t.priceOp, priceValue: t.priceValue, compareAtOp: t.compareAtOp, compareAtValue: t.compareAtValue || null })),
    };
    setFormError(null);
    setSubmitting("save");
    fetcher.submit({ intent: "save", id: form.id, rule: JSON.stringify(payload) }, { method: "post" });
  };
  const makeDefault = (id: string) => {
    fetcher.submit({ intent: "default", id }, { method: "post" });
    clearSelection();
  };
  const confirmDelete = () => {
    if (!deleting?.id) return;
    setSubmitting("delete");
    fetcher.submit({ intent: "delete", id: deleting.id }, { method: "post" });
    clearSelection();
  };

  const newRule = () => openForm({ ...EMPTY, isDefault: data.rules.length === 0 });

  return (
    <Page fullWidth title={t("page.pricing.title")} subtitle={t("page.pricing.subtitle")} primaryAction={{ content: t("pricing.addRule"), onAction: newRule }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
            {actionMessage && (
              <Banner tone="success">
                <p>{actionMessage}</p>
              </Banner>
            )}
            {errorText && !form && (
              <Banner tone="critical">
                <p>{errorText}</p>
              </Banner>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            <Stat label={t("pricing.stat.rules")} value={String(data.rules.length)} />
            <Stat label={t("pricing.stat.enabled")} value={String(enabledCount)} tone={data.rules.length > 0 && enabledCount === 0 ? "warning" : "default"} />
            <Stat label={t("pricing.stat.default")} value={defaultRule?.name ?? t("pricing.stat.builtIn")} hint={defaultRule ? describe(defaultRule, t) : t("pricing.stat.builtInHint")} />
            <Stat label={t("pricing.stat.applied")} value={String(pricedCount)} />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          {data.rules.length === 0 ? (
            <EmptyScreen heading={t("pricing.emptyState.heading")} body={t("pricing.empty")} action={{ content: t("pricing.createFirst"), onAction: () => openForm({ ...EMPTY, isDefault: true }) }} />
          ) : (
            <Card padding="0">
              <IndexTable
                resourceName={{ singular: t("pricing.resource.singular"), plural: t("pricing.resource.plural") }}
                itemCount={data.rules.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                promotedBulkActions={[
                  { content: t("action.edit"), disabled: !selectedRule, onAction: () => selectedRule && openForm(toForm(selectedRule)) },
                  { content: t("pricing.makeDefault"), disabled: !selectedRule || selectedRule.isDefault || busy, onAction: () => selectedRule?.id && makeDefault(selectedRule.id) },
                  { content: t("action.delete"), disabled: !selectedRule || busy, onAction: () => selectedRule && setDeleting(selectedRule) },
                ]}
                headings={[{ title: t("pricing.table.name") }, { title: t("pricing.table.formula") }, { title: t("pricing.table.appliesTo") }, { title: t("common.status") }]}
              >
                {/* The row itself opens the rule, the way a row opens an order in
                    the Shopify admin. Buttons inside a row would also toggle its
                    checkbox — Polaris puts the row's click handler on the <tr>. */}
                {data.rules.map((rule, index) => (
                  <IndexTable.Row id={rule.id!} key={rule.id} position={index} selected={selectedResources.includes(rule.id!)} onClick={() => openForm(toForm(rule))}>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">
                          {rule.name}
                        </Text>
                        {rule.description && (
                          <Text as="span" tone="subdued" variant="bodySm">
                            {rule.description}
                          </Text>
                        )}
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {describe(rule, t)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        {rule.isDefault && (
                          <Text as="span" variant="bodySm">
                            {t("pricing.table.appliesTo.newImports")}
                          </Text>
                        )}
                        <Text as="span" variant="bodySm" tone={rule.isDefault ? "subdued" : "base"} numeric>
                          {rule.productCount === 1 ? t("pricing.table.appliesTo.product") : t("pricing.table.appliesTo.products", { n: rule.productCount })}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100" wrap>
                        {rule.isDefault && <Badge tone="success">{t("pricing.badge.default")}</Badge>}
                        <StatusBadge status={rule.isEnabled ? "ENABLED" : "DISABLED"} />
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          )}
        </Layout.Section>
      </Layout>

      <Modal
        open={form !== null}
        onClose={closeForm}
        size="large"
        title={form?.id ? t("pricing.editRule") : t("pricing.newRule")}
        primaryAction={{ content: t("pricing.saveRule"), onAction: save, disabled: !form?.name.trim(), loading: pending("save") }}
        secondaryActions={[{ content: t("action.cancel"), onAction: closeForm }]}
      >
        {form && (
          <>
            <Modal.Section>
              <FormLayout>
                {formError && (
                  <Banner tone="critical">
                    <p>{formError}</p>
                  </Banner>
                )}
                <FormLayout.Group>
                  <TextField label={t("pricing.form.name")} value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoComplete="off" placeholder={t("pricing.form.namePlaceholder")} requiredIndicator />
                  <TextField label={t("pricing.form.description")} value={form.description} onChange={(v) => setForm({ ...form, description: v })} autoComplete="off" />
                </FormLayout.Group>
                <InlineStack gap="400" wrap>
                  <Checkbox label={t("pricing.form.isDefault")} checked={form.isDefault} onChange={(v) => setForm({ ...form, isDefault: v })} />
                  <Checkbox label={t("pricing.form.isEnabled")} checked={form.isEnabled} onChange={(v) => setForm({ ...form, isEnabled: v })} />
                  <Checkbox label={t("pricing.form.includeShipping")} checked={form.includeShipping} onChange={(v) => setForm({ ...form, includeShipping: v })} />
                  <Checkbox label={t("pricing.form.syncCostOfGoods")} checked={form.syncCostOfGoods} onChange={(v) => setForm({ ...form, syncCostOfGoods: v })} />
                </InlineStack>
              </FormLayout>
            </Modal.Section>

            <Modal.Section>
              <FormLayout>
                <Text as="h3" variant="headingSm">
                  {t("pricing.form.baseFormula")}
                </Text>
                <FormLayout.Group>
                  <Select label={t("common.price")} options={opts} value={form.basePriceOp} onChange={(v) => setForm({ ...form, basePriceOp: v as PriceOp })} />
                  <TextField label={t("pricing.form.value")} type="number" value={form.basePriceValue} onChange={(v) => setForm({ ...form, basePriceValue: v })} autoComplete="off" />
                  <Select label={t("pricing.form.compareAtPrice")} options={opts} value={form.compareAtOp} onChange={(v) => setForm({ ...form, compareAtOp: v as PriceOp })} helpText={t("pricing.form.compareAtHelp")} />
                  <TextField label={t("pricing.form.value")} type="number" value={form.compareAtValue} onChange={(v) => setForm({ ...form, compareAtValue: v })} autoComplete="off" disabled={form.compareAtOp === "NONE"} />
                </FormLayout.Group>
                <Text as="h3" variant="headingSm">
                  {t("pricing.form.guards")}
                </Text>
                <FormLayout.Group>
                  <TextField label={t("pricing.form.centsEnding")} type="number" value={form.centsEnding} onChange={(v) => setForm({ ...form, centsEnding: v })} autoComplete="off" helpText={t("pricing.form.centsEndingHelp")} />
                  <TextField label={t("pricing.form.roundToMultiple")} type="number" value={form.roundToMultiple} onChange={(v) => setForm({ ...form, roundToMultiple: v })} autoComplete="off" helpText={t("pricing.form.roundToMultipleHelp")} />
                  <TextField label={t("pricing.form.minPrice")} type="number" value={form.minPrice} onChange={(v) => setForm({ ...form, minPrice: v })} autoComplete="off" prefix={data.currency} />
                  <TextField label={t("pricing.form.maxPrice")} type="number" value={form.maxPrice} onChange={(v) => setForm({ ...form, maxPrice: v })} autoComplete="off" prefix={data.currency} />
                </FormLayout.Group>
              </FormLayout>
            </Modal.Section>

            <Modal.Section>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingSm">
                    {t("pricing.tiers.title")}
                  </Text>
                  <Button size="slim" onClick={() => setForm({ ...form, tiers: [...form.tiers, { minCost: form.tiers.length ? form.tiers[form.tiers.length - 1].maxCost || "0" : "0", maxCost: "", priceOp: "MULTIPLY", priceValue: "2", compareAtOp: "NONE", compareAtValue: "" }] })}>
                    {t("pricing.tiers.add")}
                  </Button>
                </InlineStack>
                {form.tiers.length === 0 && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    {t("pricing.tiers.help")}
                  </Text>
                )}
                {form.tiers.map((tier, i) => (
                  <Box key={i} padding="200" background="bg-surface-secondary" borderRadius="200">
                    <InlineGrid columns={{ xs: 2, md: 7 }} gap="200">
                      <TextField label={t("pricing.tiers.fromCost")} type="number" value={tier.minCost} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((tr, j) => (j === i ? { ...tr, minCost: v } : tr)) })} autoComplete="off" />
                      <TextField label={t("pricing.tiers.toCost")} type="number" value={tier.maxCost} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((tr, j) => (j === i ? { ...tr, maxCost: v } : tr)) })} autoComplete="off" placeholder="∞" />
                      <Select label={t("common.price")} options={opts} value={tier.priceOp} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((tr, j) => (j === i ? { ...tr, priceOp: v as PriceOp } : tr)) })} />
                      <TextField label={t("pricing.form.value")} type="number" value={tier.priceValue} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((tr, j) => (j === i ? { ...tr, priceValue: v } : tr)) })} autoComplete="off" />
                      <Select label={t("pricing.tiers.compareAt")} options={opts} value={tier.compareAtOp} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((tr, j) => (j === i ? { ...tr, compareAtOp: v as PriceOp } : tr)) })} />
                      <TextField label={t("pricing.form.value")} type="number" value={tier.compareAtValue} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((tr, j) => (j === i ? { ...tr, compareAtValue: v } : tr)) })} autoComplete="off" disabled={tier.compareAtOp === "NONE"} />
                      <Box paddingBlockStart="600">
                        <Button size="slim" tone="critical" onClick={() => setForm({ ...form, tiers: form.tiers.filter((_, j) => j !== i) })}>
                          {t("action.remove")}
                        </Button>
                      </Box>
                    </InlineGrid>
                  </Box>
                ))}
              </BlockStack>
            </Modal.Section>

            <Modal.Section>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  {t("pricing.preview.title")}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("pricing.preview.help", { shipping: formatMoney(2, data.currency) })}
                </Text>
                <DataTable
                  columnContentTypes={["numeric", "numeric", "numeric", "numeric", "text"]}
                  headings={[t("common.cost"), t("common.price"), t("pricing.tiers.compareAt"), t("pricing.table.margin"), t("pricing.table.tier")]}
                  rows={preview.map((p) => [
                    <Money key="cost" value={formatMoney(p.cost, data.currency)} />,
                    <Money key="price" value={formatMoney(p.price, data.currency)} />,
                    <Money key="compare" value={p.compareAtPrice ? formatMoney(p.compareAtPrice, data.currency) : "—"} />,
                    <Money key="margin" value={`${p.marginPercent}%`} />,
                    p.appliedTierId !== null ? `#${Number(p.appliedTierId) + 1}` : t("pricing.table.base"),
                  ])}
                />
              </BlockStack>
            </Modal.Section>
          </>
        )}
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={t("pricing.delete.title", { name: deleting?.name ?? "" })}
        primaryAction={{ content: t("action.delete"), destructive: true, loading: pending("delete", deleting?.id), onAction: confirmDelete }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setDeleting(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t("pricing.delete.body")}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

/** A figure in the preview table: tabular digits so the columns line up. */
function Money({ value }: { value: string }) {
  return (
    <Text as="span" numeric>
      {value}
    </Text>
  );
}

function describe(rule: PricingRuleInput, t: Translator): string {
  const op = (o: PriceOp, v: string | number | null | undefined) =>
    o === "MULTIPLY" ? `×${v}` : o === "ADD" ? `+${v}` : o === "MARGIN" ? `${t("pricing.describe.margin")} ${v}%` : o === "FIXED" ? `${t("pricing.describe.fixed")} ${v}` : t("pricing.describe.noChange");
  const parts = [`${t("pricing.describe.base")} ${op(rule.basePriceOp, rule.basePriceValue)}`];
  if (rule.compareAtOp && rule.compareAtOp !== "NONE") parts.push(`${t("pricing.describe.compareAt")} ${op(rule.compareAtOp, rule.compareAtValue)}`);
  if (rule.centsEnding !== null && rule.centsEnding !== undefined) parts.push(`${t("pricing.describe.endsIn")} .${String(rule.centsEnding).padStart(2, "0")}`);
  if (rule.roundToMultiple) parts.push(`${t("pricing.describe.roundTo")} ${rule.roundToMultiple}`);
  if (rule.tiers?.length) parts.push(`${rule.tiers.length} ${t("pricing.describe.tiers")}`);
  if (rule.includeShipping) parts.push(t("pricing.describe.shippingIncluded"));
  return parts.join(" · ");
}
