import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, Card, InlineGrid, InlineStack, Layout, List, Modal, ProgressBar, Text } from "@shopify/polaris";
import { SectionHeader } from "~/components/SectionHeader";
import { useSettingsPageAction } from "~/components/settings-page-action";
import { Stat } from "~/components/Stat";
import { PLANS, PLAN_ORDER, planRank, usageFraction, type LimitedResource, type PlanId } from "~/domain/billing/plans";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, formatMoney, formatNumber } from "~/lib/format";
import type { I18nKey } from "~/lib/i18n";
import { useErrorMessage, useLocale, useMessage, useT } from "~/lib/use-t";
import { cancelSubscription, getAccountBilling, syncSubscription } from "~/services/billing.server";

/**
 * Plans and usage.
 *
 * Opening the page reconciles the stored plan with `billing.check()`, so the
 * merchant always sees what Shopify will actually charge — including right
 * after they approve a charge and Shopify sends them back here.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, billing } = await requireShop(request);
  let syncError: string | null = null;
  if (billing) {
    try {
      await syncSubscription(shop, billing);
    } catch (error) {
      syncError = errorMessage(error);
    }
  }
  const account = await getAccountBilling(shop);
  return {
    account: {
      ...account,
      subscription: account.subscription
        ? { ...account.subscription, trialEndsAt: account.subscription.trialEndsAt?.toISOString() ?? null, renewsAt: account.subscription.renewsAt?.toISOString() ?? null }
        : null,
    },
    syncError,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, billing, actor } = await requireShop(request, { minRole: "OWNER" });
  const { intent, get } = await readForm(request);
  const account = await getAccountBilling(shop);
  try {
    switch (intent) {
      case "subscribe": {
        const plan = get("plan") as PlanId;
        if (!(plan in PLANS) || PLANS[plan].monthlyPrice === 0) return { ok: false, error: "Unknown plan" };
        if (!account.isBillingShop) return { ok: false, errorKey: "err.billingOtherStore", errorVars: { store: account.billingShopDomain ?? "" } };
        // Throws a redirect to Shopify's approval page; the merchant comes back
        // to this page afterwards and the loader picks up the new subscription.
        await billing.request({
          plan: PLANS[plan].displayName,
          isTest: account.isTest,
          returnUrl: `https://admin.shopify.com/store/${shop.domain.replace(/\.myshopify\.com$/, "")}/apps/ws-fullfill-app/app/settings/plan?billing=return`,
        });
        return { ok: true };
      }
      case "cancel": {
        await cancelSubscription(shop, billing, actor);
        return { ok: true, messageKey: "msg.planDowngraded" };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    if (e instanceof Response) throw e;
    return { ok: false, error: errorMessage(e) };
  }
};

const RESOURCES: LimitedResource[] = ["products", "stores", "staff"];

export default function PlanSettings() {
  const { account, syncError } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const fetcher = useFetcher<typeof action>();
  const t = useT();
  const locale = useLocale();
  const result = fetcher.data as { ok?: boolean; error?: string; errorKey?: string; errorVars?: Record<string, string | number>; messageKey?: string } | undefined;
  const successMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(result);
  const current = PLANS[account.plan];
  const busy = fetcher.state !== "idle";
  const busyPlan = busy ? String(fetcher.formData?.get("plan") ?? (fetcher.formData?.get("intent") === "cancel" ? "FREE" : "")) : "";
  const dateLocale = locale === "vi" ? "vi-VN" : "en-US";
  const numberLocale = dateLocale;
  const [confirmDowngrade, setConfirmDowngrade] = useState(false);
  const subscribe = (plan: PlanId) => fetcher.submit({ intent: "subscribe", plan }, { method: "post" });
  const cancel = () => fetcher.submit({ intent: "cancel" }, { method: "post" });
  const trialActive = Boolean(account.subscription?.trialEndsAt && new Date(account.subscription.trialEndsAt) > new Date());

  // The next plan up is what a merchant comes here to buy; on the top plan
  // there is nothing to promote.
  const nextPlan = PLAN_ORDER.find((id) => planRank(id) > planRank(account.plan)) ?? null;
  useSettingsPageAction(
    nextPlan && account.isBillingShop
      ? { content: t("settings.plan.upgradeTo", { plan: PLANS[nextPlan].displayName }), onAction: () => subscribe(nextPlan), loading: busyPlan === nextPlan, disabled: busy && busyPlan !== nextPlan }
      : null,
  );

  const limitText = (n: number | null) => (n === null ? t("plan.unlimited") : formatNumber(n, numberLocale));

  return (
    <Layout>
      <Layout.Section>
        <BlockStack gap="300">
          {params.get("billing") === "return" && !syncError && (
            <Banner tone="success">
              <p>{t("plan.returned", { plan: current.displayName })}</p>
            </Banner>
          )}
          {successMessage && result?.ok && (
            <Banner tone="success">
              <p>{successMessage}</p>
            </Banner>
          )}
          {failureMessage && (
            <Banner tone="critical" title={t("settings.plan.changeFailed")}>
              <p>{failureMessage}</p>
            </Banner>
          )}
          {syncError && (
            <Banner tone="warning" title={t("plan.syncFailed")}>
              <p>{syncError}</p>
            </Banner>
          )}
          {account.isTest && (
            <Banner tone="info">
              <p>{t("plan.testMode")}</p>
            </Banner>
          )}
          {!account.isBillingShop && account.billingShopDomain && (
            <Banner tone="info">
              <p>{t("plan.managedElsewhere", { store: account.billingShopDomain })}</p>
            </Banner>
          )}
        </BlockStack>
      </Layout.Section>

      <Layout.Section>
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="start" wrap gap="300">
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {t("plan.currentPlan")}: {current.displayName}
                  </Text>
                  {account.subscription?.status && (
                    <Badge tone={account.subscription.status === "ACTIVE" ? "success" : "attention"}>
                      {t(`settings.plan.subscription.${account.subscription.status}` as I18nKey) ?? account.subscription.status}
                    </Badge>
                  )}
                  {trialActive && <Badge tone="info">{t("settings.plan.trialBadge")}</Badge>}
                </InlineStack>
                <Text as="p" tone="subdued">
                  {current.monthlyPrice === 0 ? t("plan.free") : t("plan.pricePerMonth", { price: formatMoney(current.monthlyPrice, "USD") })}
                  {trialActive && account.subscription?.trialEndsAt ? ` · ${t("plan.trialEnds", { date: formatDate(account.subscription.trialEndsAt, dateLocale) })}` : ""}
                  {account.subscription?.renewsAt ? ` · ${t("plan.renews", { date: formatDate(account.subscription.renewsAt, dateLocale) })}` : ""}
                </Text>
              </BlockStack>
              {account.subscription && account.isBillingShop && (
                <Button tone="critical" onClick={() => setConfirmDowngrade(true)} loading={busyPlan === "FREE"} disabled={busy && busyPlan !== "FREE"}>
                  {t("plan.downgradeToFree")}
                </Button>
              )}
            </InlineStack>

            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
              {RESOURCES.map((resource) => {
                const limit = current.limits[resource];
                const used = account.usage[resource];
                const fraction = usageFraction(account.plan, resource, used);
                const nearLimit = fraction >= 0.9;
                return (
                  <Box key={resource} padding="300" borderColor={nearLimit ? "border-critical" : "border"} borderWidth="025" borderRadius="200">
                    <BlockStack gap="200">
                      <Stat
                        plain
                        size="medium"
                        label={t(`plan.resource.${resource}` as I18nKey)}
                        value={`${formatNumber(used, numberLocale)} / ${limitText(limit)}`}
                        tone={nearLimit ? "critical" : "default"}
                        hint={limit === null ? undefined : t("settings.plan.usage.percent", { percent: Math.round(fraction * 100) })}
                      />
                      <ProgressBar progress={Math.round(fraction * 100)} size="small" tone={nearLimit ? "critical" : "primary"} />
                    </BlockStack>
                  </Box>
                );
              })}
            </InlineGrid>
          </BlockStack>
        </Card>
      </Layout.Section>

      <Layout.Section>
        <BlockStack gap="300">
          <SectionHeader title={t("settings.plan.choose.title")} />
          <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
            {PLAN_ORDER.map((id) => {
              const plan = PLANS[id];
              const isCurrent = id === account.plan;
              const higher = planRank(id) > planRank(account.plan);
              const isNext = id === nextPlan;
              return (
                <Card key={id} background={isCurrent ? "bg-surface-secondary" : undefined}>
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center" gap="200">
                        <Text as="h3" variant="headingMd">
                          {plan.displayName}
                        </Text>
                        {isCurrent ? <Badge tone="success">{t("plan.current")}</Badge> : isNext ? <Badge tone="info">{t("settings.plan.recommended")}</Badge> : null}
                      </InlineStack>
                      <InlineStack blockAlign="baseline" gap="100">
                        <Text as="p" variant="headingXl" numeric>
                          {plan.monthlyPrice === 0 ? t("plan.free") : formatMoney(plan.monthlyPrice, "USD")}
                        </Text>
                        {plan.monthlyPrice > 0 && (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {t("plan.perMonth")}
                          </Text>
                        )}
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        {plan.trialDays > 0 ? t("plan.trialDays", { days: plan.trialDays }) : t("settings.plan.noTrial")}
                      </Text>
                    </BlockStack>
                    <List>
                      <List.Item>{t("plan.limit.products", { n: limitText(plan.limits.products) })}</List.Item>
                      <List.Item>{t("plan.limit.stores", { n: limitText(plan.limits.stores) })}</List.Item>
                      <List.Item>{t("plan.limit.staff", { n: limitText(plan.limits.staff) })}</List.Item>
                      <List.Item>{t("plan.limit.orders")}</List.Item>
                      <List.Item>{plan.limits.aiMapping ? t("plan.feature.aiMapping") : t("plan.feature.noAiMapping")}</List.Item>
                      <List.Item>{plan.limits.autoPlaceOrders ? t("plan.feature.autoPlace") : t("plan.feature.noAutoPlace")}</List.Item>
                    </List>
                    {isCurrent ? (
                      <Button disabled fullWidth>
                        {t("plan.current")}
                      </Button>
                    ) : plan.monthlyPrice === 0 ? (
                      <Button fullWidth onClick={() => setConfirmDowngrade(true)} loading={busyPlan === "FREE"} disabled={!account.isBillingShop || (busy && busyPlan !== "FREE")}>
                        {t("plan.downgradeToFree")}
                      </Button>
                    ) : (
                      <Button fullWidth variant={higher ? "primary" : undefined} onClick={() => subscribe(id)} loading={busyPlan === id} disabled={!account.isBillingShop || (busy && busyPlan !== id)}>
                        {higher ? t("plan.upgrade") : t("plan.switch")}
                      </Button>
                    )}
                  </BlockStack>
                </Card>
              );
            })}
          </InlineGrid>
        </BlockStack>
      </Layout.Section>

      <Layout.AnnotatedSection title={t("plan.howBillingWorks")} description={t("settings.plan.howBillingWorks.description")}>
        <Card>
          <List type="number">
            <List.Item>{t("plan.note.shopifyBills")}</List.Item>
            <List.Item>{t("plan.note.accountWide")}</List.Item>
            <List.Item>{t("plan.note.downgrade")}</List.Item>
            <List.Item>{t("plan.note.supplierPayments")}</List.Item>
          </List>
        </Card>
      </Layout.AnnotatedSection>

      <Modal
        open={confirmDowngrade}
        onClose={() => setConfirmDowngrade(false)}
        title={t("settings.plan.downgradeConfirm.title")}
        primaryAction={{
          content: t("plan.downgradeToFree"),
          destructive: true,
          loading: busyPlan === "FREE",
          onAction: () => {
            cancel();
            setConfirmDowngrade(false);
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setConfirmDowngrade(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">{t("settings.plan.downgradeConfirm.body", { plan: current.displayName })}</Text>
            <Text as="p" tone="subdued">
              {t("plan.note.downgrade")}
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Layout>
  );
}
