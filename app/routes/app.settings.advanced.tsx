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
        return { ok: true, message: "New token generated. Paste it into the browser extension." };
      }
      case "revoke-token":
        await prisma.shop.update({ where: { id: shop.id }, data: { apiToken: null } });
        return { ok: true, message: "Token revoked." };
      case "refresh-rates": {
        const n = await refreshRates(shop.parsedSettings.currency.supplierCurrency);
        return { ok: true, message: `${n} exchange rates refreshed.` };
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

  return (
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

      <Layout.AnnotatedSection title="Browser extension / API" description="Capture products while browsing supplier sites. The token authenticates the extension against this store.">
        <Card>
          <FormLayout>
            <TextField label="API endpoint" value={`${data.appUrl}/api/extension/capture`} readOnly autoComplete="off" />
            <TextField label="Token" value={data.apiToken ?? "— not generated —"} readOnly autoComplete="off" type={data.apiToken ? "text" : undefined} />
            <InlineStack gap="200">
              <Button onClick={() => fetcher.submit({ intent: "rotate-token" }, { method: "post" })}>{data.apiToken ? "Rotate token" : "Generate token"}</Button>
              {data.apiToken && (
                <Button tone="critical" onClick={() => fetcher.submit({ intent: "revoke-token" }, { method: "post" })}>
                  Revoke
                </Button>
              )}
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              POST JSON {"{ url }"} with header <code>Authorization: Bearer &lt;token&gt;</code> to add a product to the import list. See docs/EXTENSION_API.md.
            </Text>
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="System" description="Runtime configuration of this deployment.">
        <Card>
          <BlockStack gap="200">
            <InlineStack gap="200">
              <Text as="span">Supplier driver</Text>
              <Badge tone={data.supplierDriver === "live" ? "success" : "attention"}>{data.supplierDriver}</Badge>
            </InlineStack>
            <InlineStack gap="200">
              <Text as="span">Token encryption</Text>
              <Badge tone={data.encryption ? "success" : "warning"}>{data.encryption ? "enabled" : "disabled"}</Badge>
            </InlineStack>
            <InlineStack gap="200">
              <Text as="span">Job queue</Text>
              <Badge tone={data.queue.mode === "redis" ? "success" : "attention"}>{data.queue.mode}</Badge>
              {data.queue.mode === "redis" && (
                <Text as="span" tone="subdued" variant="bodySm">
                  {data.queue.waiting} waiting · {data.queue.active} active · {data.queue.delayed} delayed · {data.queue.failed} failed
                </Text>
              )}
            </InlineStack>
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="Exchange rates" description={`${data.supplierCurrency} → ${data.shopCurrency} and other common currencies.`}>
        <Card>
          <BlockStack gap="200">
            <Button onClick={() => fetcher.submit({ intent: "refresh-rates" }, { method: "post" })} loading={fetcher.state !== "idle"}>
              Refresh now
            </Button>
            {data.rates.length === 0 ? (
              <Text as="p" tone="subdued">
                No rates cached yet.
              </Text>
            ) : (
              <DataTable columnContentTypes={["text", "numeric", "text"]} headings={["Currency", "Rate", "Fetched"]} rows={data.rates.map((r) => [r.quote, r.rate, formatDate(r.fetchedAt)])} />
            )}
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="Recent webhooks" description="Shopify events received for this store.">
        <Card>
          {data.webhooks.length === 0 ? (
            <Text as="p" tone="subdued">
              No webhooks received yet.
            </Text>
          ) : (
            <DataTable
              columnContentTypes={["text", "text", "text"]}
              headings={["Topic", "Received", "Status"]}
              rows={data.webhooks.map((w) => [w.topic, formatDate(w.createdAt), w.error ? `Error: ${w.error}` : w.processedAt ? "Processed" : "Queued"])}
            />
          )}
        </Card>
      </Layout.AnnotatedSection>
    </Layout>
  );
}
