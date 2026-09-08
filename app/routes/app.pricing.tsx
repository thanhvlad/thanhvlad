import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, Card, Checkbox, DataTable, Divider, FormLayout, InlineGrid, InlineStack, Layout, Page, Select, Text, TextField } from "@shopify/polaris";
import type { PriceOp, PricingRuleInput } from "~/domain/pricing/types";
import { computePrice } from "~/domain/pricing/engine";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney } from "~/lib/format";
import type { Translator } from "~/lib/i18n";
import { useMessage, useT } from "~/lib/use-t";
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
  const rules = await listPricingRules(shop.id);
  return {
    currency: shop.currency,
    rules: rules.map((r) => ({ ...toRuleInput(r), id: r.id, name: r.name, description: r.description, isDefault: r.isDefault, isEnabled: r.isEnabled, syncCostOfGoods: r.syncCostOfGoods, productCount: 0 })),
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

function toForm(rule: Awaited<ReturnType<typeof loader>>["rules"][number]): RuleForm {
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
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const [form, setForm] = useState<RuleForm | null>(null);
  const opts = opOptions(t);
  const sampleCosts = [1, 2.5, 5, 10, 20, 50, 100];
  const preview = form ? sampleCosts.map((cost) => ({ cost, ...computePrice(toRuleInputFromForm(form), { cost, shippingCost: 2 }) })) : [];

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
    fetcher.submit({ intent: "save", id: form.id, rule: JSON.stringify(payload) }, { method: "post" });
    setForm(null);
  };

  return (
    <Page title={t("page.pricing.title")} subtitle={t("page.pricing.subtitle")} primaryAction={{ content: t("pricing.newRule"), onAction: () => setForm({ ...EMPTY, isDefault: data.rules.length === 0 }) }}>
      <Layout>
        <Layout.Section>
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
        </Layout.Section>

        {form && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  {form.id ? t("pricing.editRule") : t("pricing.newRule")}
                </Text>
                <FormLayout>
                  <FormLayout.Group>
                    <TextField label={t("pricing.form.name")} value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoComplete="off" placeholder={t("pricing.form.namePlaceholder")} />
                    <TextField label={t("pricing.form.description")} value={form.description} onChange={(v) => setForm({ ...form, description: v })} autoComplete="off" />
                  </FormLayout.Group>
                  <InlineStack gap="400">
                    <Checkbox label={t("pricing.form.isDefault")} checked={form.isDefault} onChange={(v) => setForm({ ...form, isDefault: v })} />
                    <Checkbox label={t("pricing.form.isEnabled")} checked={form.isEnabled} onChange={(v) => setForm({ ...form, isEnabled: v })} />
                    <Checkbox label={t("pricing.form.includeShipping")} checked={form.includeShipping} onChange={(v) => setForm({ ...form, includeShipping: v })} />
                    <Checkbox label={t("pricing.form.syncCostOfGoods")} checked={form.syncCostOfGoods} onChange={(v) => setForm({ ...form, syncCostOfGoods: v })} />
                  </InlineStack>
                  <Divider />
                  <Text as="h3" variant="headingSm">
                    {t("pricing.form.baseFormula")}
                  </Text>
                  <FormLayout.Group>
                    <Select label={t("common.price")} options={opts} value={form.basePriceOp} onChange={(v) => setForm({ ...form, basePriceOp: v as PriceOp })} />
                    <TextField label={t("pricing.form.value")} type="number" value={form.basePriceValue} onChange={(v) => setForm({ ...form, basePriceValue: v })} autoComplete="off" />
                    <Select label={t("pricing.form.compareAtPrice")} options={opts} value={form.compareAtOp} onChange={(v) => setForm({ ...form, compareAtOp: v as PriceOp })} helpText={t("pricing.form.compareAtHelp")} />
                    <TextField label={t("pricing.form.value")} type="number" value={form.compareAtValue} onChange={(v) => setForm({ ...form, compareAtValue: v })} autoComplete="off" disabled={form.compareAtOp === "NONE"} />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField label={t("pricing.form.centsEnding")} type="number" value={form.centsEnding} onChange={(v) => setForm({ ...form, centsEnding: v })} autoComplete="off" helpText={t("pricing.form.centsEndingHelp")} />
                    <TextField label={t("pricing.form.roundToMultiple")} type="number" value={form.roundToMultiple} onChange={(v) => setForm({ ...form, roundToMultiple: v })} autoComplete="off" helpText={t("pricing.form.roundToMultipleHelp")} />
                    <TextField label={t("pricing.form.minPrice")} type="number" value={form.minPrice} onChange={(v) => setForm({ ...form, minPrice: v })} autoComplete="off" prefix={data.currency} />
                    <TextField label={t("pricing.form.maxPrice")} type="number" value={form.maxPrice} onChange={(v) => setForm({ ...form, maxPrice: v })} autoComplete="off" prefix={data.currency} />
                  </FormLayout.Group>
                  <Divider />
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
                  <Divider />
                  <Text as="h3" variant="headingSm">
                    {`${t("pricing.preview.title")} (${t("pricing.preview.shippingAssumed")} ${formatMoney(2, data.currency)})`}
                  </Text>
                  <DataTable
                    columnContentTypes={["numeric", "numeric", "numeric", "numeric", "text"]}
                    headings={[t("common.cost"), t("common.price"), t("pricing.tiers.compareAt"), t("pricing.table.margin"), t("pricing.table.tier")]}
                    rows={preview.map((p) => [formatMoney(p.cost, data.currency), formatMoney(p.price, data.currency), p.compareAtPrice ? formatMoney(p.compareAtPrice, data.currency) : "—", `${p.marginPercent}%`, p.appliedTierId !== null ? `#${Number(p.appliedTierId) + 1}` : t("pricing.table.base")])}
                  />
                  <InlineStack gap="200">
                    <Button variant="primary" onClick={save} disabled={!form.name.trim()} loading={fetcher.state !== "idle"}>
                      {t("pricing.saveRule")}
                    </Button>
                    <Button onClick={() => setForm(null)}>{t("action.cancel")}</Button>
                  </InlineStack>
                </FormLayout>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <BlockStack gap="300">
            {data.rules.length === 0 && !form && (
              <Card>
                <BlockStack gap="200">
                  <Text as="p">{t("pricing.empty")}</Text>
                  <Button onClick={() => setForm({ ...EMPTY, isDefault: true })}>{t("pricing.createFirst")}</Button>
                </BlockStack>
              </Card>
            )}
            {data.rules.map((rule) => (
              <Card key={rule.id}>
                <InlineStack align="space-between" blockAlign="start" wrap>
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">
                        {rule.name}
                      </Text>
                      {rule.isDefault && <Badge tone="success">{t("pricing.badge.default")}</Badge>}
                      {!rule.isEnabled && <Badge>{t("common.disabled")}</Badge>}
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      {describe(rule, t)}
                    </Text>
                    {rule.description && <Text as="p">{rule.description}</Text>}
                  </BlockStack>
                  <InlineStack gap="100">
                    <Button size="slim" onClick={() => setForm(toForm(rule))}>
                      {t("action.edit")}
                    </Button>
                    {!rule.isDefault && (
                      <Button size="slim" onClick={() => fetcher.submit({ intent: "default", id: rule.id! }, { method: "post" })}>
                        {t("pricing.makeDefault")}
                      </Button>
                    )}
                    <Button size="slim" tone="critical" onClick={() => fetcher.submit({ intent: "delete", id: rule.id! }, { method: "post" })}>
                      {t("action.delete")}
                    </Button>
                  </InlineStack>
                </InlineStack>
              </Card>
            ))}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
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
