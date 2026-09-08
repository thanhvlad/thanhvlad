import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, Card, InlineGrid, InlineStack, Layout, List, ProgressBar, Text } from "@shopify/polaris";
import { PLANS, PLAN_ORDER, planRank, usageFraction, type LimitedResource, type PlanId } from "~/domain/billing/plans";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, formatMoney } from "~/lib/format";
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
  const { shop, billing, actor } = await requireShop(request);
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
  const dateLocale = locale === "vi" ? "vi-VN" : "en-US";

  return (
    <Layout>
      <Layout.Section>
        <BlockStack gap="300">
          {params.get("billing") === "return" && !syncError && (
            <Banner tone="success">
              <p>{t("plan.returned", { plan: current.displayName })}</p>
            </Banner>
          )}
          {successMessage && (
            <Banner tone="success">
              <p>{successMessage}</p>
            </Banner>
          )}
          {failureMessage && (
            <Banner tone="critical">
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
            <InlineStack align="space-between" blockAlign="center" wrap>
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {t("plan.currentPlan")}: {current.displayName}
                  </Text>
                  {account.subscription?.status && <Badge tone={account.subscription.status === "ACTIVE" ? "success" : "attention"}>{account.subscription.status}</Badge>}
                </InlineStack>
                <Text as="p" tone="subdued">
                  {current.monthlyPrice === 0 ? t("plan.free") : t("plan.pricePerMonth", { price: formatMoney(current.monthlyPrice, "USD") })}
                  {account.subscription?.trialEndsAt && new Date(account.subscription.trialEndsAt) > new Date()
                    ? ` · ${t("plan.trialEnds", { date: formatDate(account.subscription.trialEndsAt, dateLocale) })}`
                    : ""}
                  {account.subscription?.renewsAt ? ` · ${t("plan.renews", { date: formatDate(account.subscription.renewsAt, dateLocale) })}` : ""}
                </Text>
              </BlockStack>
              {account.subscription && account.isBillingShop && (
                <Button tone="critical" onClick={() => fetcher.submit({ intent: "cancel" }, { method: "post" })} loading={busy}>
                  {t("plan.downgradeToFree")}
                </Button>
              )}
            </InlineStack>

            <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
              {RESOURCES.map((resource) => {
                const limit = current.limits[resource];
                const used = account.usage[resource];
                const fraction = usageFraction(account.plan, resource, used);
                return (
                  <Box key={resource} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text as="span" fontWeight="semibold">
                          {t(`plan.resource.${resource}` as I18nKey)}
                        </Text>
                        <Text as="span" tone={fraction >= 0.9 ? "critical" : "subdued"}>
                          {used} / {limit === null ? t("plan.unlimited") : limit}
                        </Text>
                      </InlineStack>
                      <ProgressBar progress={Math.round(fraction * 100)} size="small" tone={fraction >= 0.9 ? "critical" : "primary"} />
                    </BlockStack>
                  </Box>
                );
              })}
            </InlineGrid>
          </BlockStack>
        </Card>
      </Layout.Section>

      <Layout.Section>
        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          {PLAN_ORDER.map((id) => {
            const plan = PLANS[id];
            const isCurrent = id === account.plan;
            const higher = planRank(id) > planRank(account.plan);
            return (
              <Card key={id}>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      {plan.displayName}
                    </Text>
                    {isCurrent && <Badge tone="success">{t("plan.current")}</Badge>}
                  </InlineStack>
                  <Text as="p" variant="headingLg">
                    {plan.monthlyPrice === 0 ? t("plan.free") : formatMoney(plan.monthlyPrice, "USD")}
                    {plan.monthlyPrice > 0 && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {" "}
                        {t("plan.perMonth")}
                      </Text>
                    )}
                  </Text>
                  {plan.trialDays > 0 && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      {t("plan.trialDays", { days: plan.trialDays })}
                    </Text>
                  )}
                  <List>
                    <List.Item>{t("plan.limit.products", { n: plan.limits.products ?? t("plan.unlimited") })}</List.Item>
                    <List.Item>{t("plan.limit.stores", { n: plan.limits.stores ?? t("plan.unlimited") })}</List.Item>
                    <List.Item>{t("plan.limit.staff", { n: plan.limits.staff ?? t("plan.unlimited") })}</List.Item>
                    <List.Item>{t("plan.limit.orders")}</List.Item>
                    <List.Item>{plan.limits.aiMapping ? t("plan.feature.aiMapping") : t("plan.feature.noAiMapping")}</List.Item>
                    <List.Item>{plan.limits.autoPlaceOrders ? t("plan.feature.autoPlace") : t("plan.feature.noAutoPlace")}</List.Item>
                  </List>
                  {isCurrent ? (
                    <Button disabled>{t("plan.current")}</Button>
                  ) : plan.monthlyPrice === 0 ? (
                    <Button onClick={() => fetcher.submit({ intent: "cancel" }, { method: "post" })} loading={busy} disabled={!account.isBillingShop}>
                      {t("plan.downgradeToFree")}
                    </Button>
                  ) : (
                    <Button variant={higher ? "primary" : undefined} onClick={() => fetcher.submit({ intent: "subscribe", plan: id }, { method: "post" })} loading={busy} disabled={!account.isBillingShop}>
                      {higher ? t("plan.upgrade") : t("plan.switch")}
                    </Button>
                  )}
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>
      </Layout.Section>

      <Layout.Section>
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              {t("plan.howBillingWorks")}
            </Text>
            <List>
              <List.Item>{t("plan.note.shopifyBills")}</List.Item>
              <List.Item>{t("plan.note.accountWide")}</List.Item>
              <List.Item>{t("plan.note.downgrade")}</List.Item>
              <List.Item>{t("plan.note.supplierPayments")}</List.Item>
            </List>
          </BlockStack>
        </Card>
      </Layout.Section>
    </Layout>
  );
}
