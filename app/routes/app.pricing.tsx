import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, Card, Checkbox, DataTable, Divider, FormLayout, InlineGrid, InlineStack, Layout, Page, Select, Text, TextField } from "@shopify/polaris";
import type { PriceOp, PricingRuleInput } from "~/domain/pricing/types";
import { computePrice } from "~/domain/pricing/engine";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatMoney } from "~/lib/format";
import { createPricingRule, deletePricingRule, listPricingRules, setDefaultPricingRule, toRuleInput, updatePricingRule, type PricingRuleFormInput } from "~/services/pricing.server";

const OP_OPTIONS: Array<{ label: string; value: PriceOp }> = [
  { label: "Multiply cost by", value: "MULTIPLY" },
  { label: "Add fixed amount", value: "ADD" },
  { label: "Target margin %", value: "MARGIN" },
  { label: "Fixed price", value: "FIXED" },
  { label: "No change", value: "NONE" },
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
        return { ok: true, message: "Pricing rule saved." };
      }
      case "delete":
        await deletePricingRule(shop.id, get("id"));
        return { ok: true, message: "Pricing rule deleted." };
      case "default":
        await setDefaultPricingRule(shop.id, get("id"));
        return { ok: true, message: "Default rule updated." };
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
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const [form, setForm] = useState<RuleForm | null>(null);
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
    <Page title="Pricing rules" subtitle="Turn supplier costs into store prices automatically." primaryAction={{ content: "New rule", onAction: () => setForm({ ...EMPTY, isDefault: data.rules.length === 0 }) }}>
      <Layout>
        <Layout.Section>
          {result?.message && (
            <Banner tone="success">
              <p>{result.message}</p>
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
                  {form.id ? "Edit rule" : "New rule"}
                </Text>
                <FormLayout>
                  <FormLayout.Group>
                    <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoComplete="off" placeholder="e.g. Standard 2x" />
                    <TextField label="Description" value={form.description} onChange={(v) => setForm({ ...form, description: v })} autoComplete="off" />
                  </FormLayout.Group>
                  <InlineStack gap="400">
                    <Checkbox label="Default rule for new imports" checked={form.isDefault} onChange={(v) => setForm({ ...form, isDefault: v })} />
                    <Checkbox label="Enabled" checked={form.isEnabled} onChange={(v) => setForm({ ...form, isEnabled: v })} />
                    <Checkbox label="Include supplier shipping in cost" checked={form.includeShipping} onChange={(v) => setForm({ ...form, includeShipping: v })} />
                    <Checkbox label="Write cost to Shopify 'Cost per item'" checked={form.syncCostOfGoods} onChange={(v) => setForm({ ...form, syncCostOfGoods: v })} />
                  </InlineStack>
                  <Divider />
                  <Text as="h3" variant="headingSm">
                    Base formula (when no tier matches)
                  </Text>
                  <FormLayout.Group>
                    <Select label="Price" options={OP_OPTIONS} value={form.basePriceOp} onChange={(v) => setForm({ ...form, basePriceOp: v as PriceOp })} />
                    <TextField label="Value" type="number" value={form.basePriceValue} onChange={(v) => setForm({ ...form, basePriceValue: v })} autoComplete="off" />
                    <Select label="Compare-at price" options={OP_OPTIONS} value={form.compareAtOp} onChange={(v) => setForm({ ...form, compareAtOp: v as PriceOp })} helpText="Applied to the computed price" />
                    <TextField label="Value" type="number" value={form.compareAtValue} onChange={(v) => setForm({ ...form, compareAtValue: v })} autoComplete="off" disabled={form.compareAtOp === "NONE"} />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField label="Cents ending" type="number" value={form.centsEnding} onChange={(v) => setForm({ ...form, centsEnding: v })} autoComplete="off" helpText="e.g. 99 → 19.99; blank keeps cents" />
                    <TextField label="Round up to multiple of" type="number" value={form.roundToMultiple} onChange={(v) => setForm({ ...form, roundToMultiple: v })} autoComplete="off" helpText="e.g. 5 → 21.40 becomes 25" />
                    <TextField label="Minimum price" type="number" value={form.minPrice} onChange={(v) => setForm({ ...form, minPrice: v })} autoComplete="off" prefix={data.currency} />
                    <TextField label="Maximum price" type="number" value={form.maxPrice} onChange={(v) => setForm({ ...form, maxPrice: v })} autoComplete="off" prefix={data.currency} />
                  </FormLayout.Group>
                  <Divider />
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      Cost-range tiers
                    </Text>
                    <Button size="slim" onClick={() => setForm({ ...form, tiers: [...form.tiers, { minCost: form.tiers.length ? form.tiers[form.tiers.length - 1].maxCost || "0" : "0", maxCost: "", priceOp: "MULTIPLY", priceValue: "2", compareAtOp: "NONE", compareAtValue: "" }] })}>
                      Add tier
                    </Button>
                  </InlineStack>
                  {form.tiers.length === 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Optional. Tiers let cheap items carry a higher multiplier than expensive ones (e.g. $0–5 ×3, $5–20 ×2.2, $20+ ×1.8).
                    </Text>
                  )}
                  {form.tiers.map((tier, i) => (
                    <Box key={i} padding="200" background="bg-surface-secondary" borderRadius="200">
                      <InlineGrid columns={{ xs: 2, md: 7 }} gap="200">
                        <TextField label="From cost" type="number" value={tier.minCost} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((t, j) => (j === i ? { ...t, minCost: v } : t)) })} autoComplete="off" />
                        <TextField label="To cost" type="number" value={tier.maxCost} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((t, j) => (j === i ? { ...t, maxCost: v } : t)) })} autoComplete="off" placeholder="∞" />
                        <Select label="Price" options={OP_OPTIONS} value={tier.priceOp} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((t, j) => (j === i ? { ...t, priceOp: v as PriceOp } : t)) })} />
                        <TextField label="Value" type="number" value={tier.priceValue} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((t, j) => (j === i ? { ...t, priceValue: v } : t)) })} autoComplete="off" />
                        <Select label="Compare-at" options={OP_OPTIONS} value={tier.compareAtOp} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((t, j) => (j === i ? { ...t, compareAtOp: v as PriceOp } : t)) })} />
                        <TextField label="Value" type="number" value={tier.compareAtValue} onChange={(v) => setForm({ ...form, tiers: form.tiers.map((t, j) => (j === i ? { ...t, compareAtValue: v } : t)) })} autoComplete="off" disabled={tier.compareAtOp === "NONE"} />
                        <Box paddingBlockStart="600">
                          <Button size="slim" tone="critical" onClick={() => setForm({ ...form, tiers: form.tiers.filter((_, j) => j !== i) })}>
                            Remove
                          </Button>
                        </Box>
                      </InlineGrid>
                    </Box>
                  ))}
                  <Divider />
                  <Text as="h3" variant="headingSm">
                    Preview (supplier shipping assumed {formatMoney(2, data.currency)})
                  </Text>
                  <DataTable
                    columnContentTypes={["numeric", "numeric", "numeric", "numeric", "text"]}
                    headings={["Cost", "Price", "Compare-at", "Margin", "Tier"]}
                    rows={preview.map((p) => [formatMoney(p.cost, data.currency), formatMoney(p.price, data.currency), p.compareAtPrice ? formatMoney(p.compareAtPrice, data.currency) : "—", `${p.marginPercent}%`, p.appliedTierId !== null ? `#${Number(p.appliedTierId) + 1}` : "base"])}
                  />
                  <InlineStack gap="200">
                    <Button variant="primary" onClick={save} disabled={!form.name.trim()} loading={fetcher.state !== "idle"}>
                      Save rule
                    </Button>
                    <Button onClick={() => setForm(null)}>Cancel</Button>
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
                  <Text as="p">No pricing rule yet — imports use the built-in default (2× cost, compare-at 1.4×, .99 ending).</Text>
                  <Button onClick={() => setForm({ ...EMPTY, isDefault: true })}>Create your first rule</Button>
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
                      {rule.isDefault && <Badge tone="success">Default</Badge>}
                      {!rule.isEnabled && <Badge>Disabled</Badge>}
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      {describe(rule)}
                    </Text>
                    {rule.description && <Text as="p">{rule.description}</Text>}
                  </BlockStack>
                  <InlineStack gap="100">
                    <Button size="slim" onClick={() => setForm(toForm(rule))}>
                      Edit
                    </Button>
                    {!rule.isDefault && (
                      <Button size="slim" onClick={() => fetcher.submit({ intent: "default", id: rule.id! }, { method: "post" })}>
                        Make default
                      </Button>
                    )}
                    <Button size="slim" tone="critical" onClick={() => fetcher.submit({ intent: "delete", id: rule.id! }, { method: "post" })}>
                      Delete
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

function describe(rule: PricingRuleInput): string {
  const op = (o: PriceOp, v: string | number | null | undefined) =>
    o === "MULTIPLY" ? `×${v}` : o === "ADD" ? `+${v}` : o === "MARGIN" ? `${v}% margin` : o === "FIXED" ? `fixed ${v}` : "no change";
  const parts = [`Base ${op(rule.basePriceOp, rule.basePriceValue)}`];
  if (rule.compareAtOp && rule.compareAtOp !== "NONE") parts.push(`compare-at ${op(rule.compareAtOp, rule.compareAtValue)}`);
  if (rule.centsEnding !== null && rule.centsEnding !== undefined) parts.push(`.${String(rule.centsEnding).padStart(2, "0")} ending`);
  if (rule.roundToMultiple) parts.push(`round to ${rule.roundToMultiple}`);
  if (rule.tiers?.length) parts.push(`${rule.tiers.length} tier(s)`);
  if (rule.includeShipping) parts.push("shipping included");
  return parts.join(" · ");
}
