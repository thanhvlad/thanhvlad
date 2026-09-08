import crypto from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Badge, Banner, BlockStack, Button, Card, DataTable, FormLayout, InlineStack, Layout, Text, TextField } from "@shopify/polaris";
import prisma from "~/db.server";
import { readForm, requireShop } from "~/lib/auth.server";
import { encryptionConfigured } from "~/lib/crypto.server";
import { env } from "~/lib/env.server";
import { errorMessage } from "~/lib/errors";
import { formatDate } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
import { listRates, refreshRates } from "~/services/currency.server";
import { queueStats } from "~/services/jobs/index.server";
import { logActivity } from "~/services/activity.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const [queue, rates, webhooks] = await Promise.all([
    queueStats(),
    listRates(shop.parsedSettings.currency.supplierCurrency),
    prisma.webhookEvent.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  return {
    apiToken: shop.apiToken,
    appUrl: env().SHOPIFY_APP_URL,
    supplierDriver: env().SUPPLIER_DRIVER,
    encryption: encryptionConfigured(),
    queue,
    rates: rates.filter((r) => ["USD", "EUR", "GBP", "VND", "CNY", "AUD", "CAD", shop.currency].includes(r.quote)).map((r) => ({ quote: r.quote, rate: r.rate.toString(), fetchedAt: r.fetchedAt })),
    webhooks: webhooks.map((w) => ({ id: w.id, topic: w.topic, createdAt: w.createdAt, processedAt: w.processedAt, error: w.error })),
    shopCurrency: shop.currency,
    supplierCurrency: shop.parsedSettings.currency.supplierCurrency,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { intent } = await readForm(request);
  try {
    switch (intent) {
      case "rotate-token": {
        const token = `dsh_${crypto.randomBytes(24).toString("base64url")}`;
        await prisma.shop.update({ where: { id: shop.id }, data: { apiToken: token } });
        await logActivity(shop.id, { action: "api.token_rotated", message: "Extension API token rotated." });
        return { ok: true, messageKey: "msg.tokenGenerated" };
      }
      case "revoke-token":
        await prisma.shop.update({ where: { id: shop.id }, data: { apiToken: null } });
        return { ok: true, messageKey: "msg.tokenRevoked" };
      case "refresh-rates": {
        const n = await refreshRates(shop.parsedSettings.currency.supplierCurrency);
        return { ok: true, messageKey: "msg.ratesRefreshed", messageVars: { n } };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function AdvancedSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const t = useT();

  return (
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

      <Layout.AnnotatedSection title={t("settings.advanced.extension.title")} description={t("settings.advanced.extension.description")}>
        <Card>
          <FormLayout>
            <TextField label={t("settings.advanced.apiEndpoint")} value={`${data.appUrl}/api/extension/capture`} readOnly autoComplete="off" />
            <TextField label={t("settings.advanced.token")} value={data.apiToken ?? t("settings.advanced.tokenNotGenerated")} readOnly autoComplete="off" type={data.apiToken ? "text" : undefined} />
            <InlineStack gap="200">
              <Button onClick={() => fetcher.submit({ intent: "rotate-token" }, { method: "post" })}>{data.apiToken ? t("settings.advanced.rotateToken") : t("settings.advanced.generateToken")}</Button>
              {data.apiToken && (
                <Button tone="critical" onClick={() => fetcher.submit({ intent: "revoke-token" }, { method: "post" })}>
                  {t("settings.advanced.revokeToken")}
                </Button>
              )}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              {t("settings.advanced.extension.helpBefore")} <code>Authorization: Bearer &lt;token&gt;</code> {t("settings.advanced.extension.helpAfter")}
            </Text>
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.advanced.system.title")} description={t("settings.advanced.system.description")}>
        <Card>
          <BlockStack gap="200">
            <InlineStack gap="200">
              <Text as="span">{t("settings.advanced.supplierDriver")}</Text>
              <Badge tone={data.supplierDriver === "live" ? "success" : "attention"}>{data.supplierDriver}</Badge>
            </InlineStack>
            <InlineStack gap="200">
              <Text as="span">{t("settings.advanced.tokenEncryption")}</Text>
              <Badge tone={data.encryption ? "success" : "warning"}>{data.encryption ? t("common.enabled") : t("common.disabled")}</Badge>
            </InlineStack>
            <InlineStack gap="200">
              <Text as="span">{t("settings.advanced.jobQueue")}</Text>
              <Badge tone={data.queue.mode === "redis" ? "success" : "attention"}>{data.queue.mode}</Badge>
              {data.queue.mode === "redis" && (
                <Text as="span" tone="subdued" variant="bodySm">
                  {data.queue.waiting} {t("settings.advanced.queue.waiting")} · {data.queue.active} {t("settings.advanced.queue.active")} · {data.queue.delayed} {t("settings.advanced.queue.delayed")} · {data.queue.failed}{" "}
                  {t("settings.advanced.queue.failed")}
                </Text>
              )}
            </InlineStack>
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.advanced.rates.title")} description={`${data.supplierCurrency} → ${data.shopCurrency} ${t("settings.advanced.rates.description")}`}>
        <Card>
          <BlockStack gap="200">
            <Button onClick={() => fetcher.submit({ intent: "refresh-rates" }, { method: "post" })} loading={fetcher.state !== "idle"}>
              {t("settings.advanced.rates.refresh")}
            </Button>
            {data.rates.length === 0 ? (
              <Text as="p" tone="subdued">
                {t("settings.advanced.rates.empty")}
              </Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "numeric", "text"]}
                headings={[t("settings.advanced.rates.currency"), t("settings.advanced.rates.rate"), t("settings.advanced.rates.fetched")]}
                rows={data.rates.map((r) => [r.quote, r.rate, formatDate(r.fetchedAt)])}
              />
            )}
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.advanced.webhooks.title")} description={t("settings.advanced.webhooks.description")}>
        <Card>
          {data.webhooks.length === 0 ? (
            <Text as="p" tone="subdued">
              {t("settings.advanced.webhooks.empty")}
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text"]}
              headings={[t("settings.advanced.webhooks.topic"), t("settings.advanced.webhooks.received"), t("common.status")]}
              rows={data.webhooks.map((w) => [
                w.topic,
                formatDate(w.createdAt),
                w.error ? `${t("common.error")}: ${w.error}` : w.processedAt ? t("settings.advanced.webhooks.processed") : t("settings.advanced.webhooks.queued"),
              ])}
            />
          )}
        </Card>
      </Layout.AnnotatedSection>
    </Layout>
  );
}
