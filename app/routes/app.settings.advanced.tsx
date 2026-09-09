import crypto from "node:crypto";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Badge, Banner, BlockStack, Box, Button, Card, DataTable, DescriptionList, FormLayout, InlineStack, Layout, Modal, Text, TextField, Tooltip } from "@shopify/polaris";
import { ClipboardIcon } from "@shopify/polaris-icons";
import { EmptyScreen } from "~/components/EmptyScreen";
import { SectionHeader } from "~/components/SectionHeader";
import { useSettingsPageAction } from "~/components/settings-page-action";
import prisma from "~/db.server";
import { readForm, requireShop } from "~/lib/auth.server";
import { encryptionConfigured } from "~/lib/crypto.server";
import { env } from "~/lib/env.server";
import { errorMessage } from "~/lib/errors";
import { formatDate } from "~/lib/format";
import { useErrorMessage, useLocale, useMessage, useT } from "~/lib/use-t";
import { listRates, refreshRates } from "~/services/currency.server";
import { emailProvider } from "~/services/email.server";
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
    emailProvider: emailProvider(),
    queue,
    rates: rates.filter((r) => ["USD", "EUR", "GBP", "VND", "CNY", "AUD", "CAD", shop.currency].includes(r.quote)).map((r) => ({ quote: r.quote, rate: r.rate.toString(), fetchedAt: r.fetchedAt })),
    webhooks: webhooks.map((w) => ({ id: w.id, topic: w.topic, createdAt: w.createdAt, processedAt: w.processedAt, error: w.error })),
    shopCurrency: shop.currency,
    supplierCurrency: shop.parsedSettings.currency.supplierCurrency,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request, { minRole: "ADMIN" });
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
  const shopify = useAppBridge();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(result as Parameters<typeof useErrorMessage>[0]);
  const t = useT();
  const locale = useLocale();
  const dateLocale = locale === "vi" ? "vi-VN" : "en-US";
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
  const busy = fetcher.state !== "idle";
  const busyIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const submit = (intent: string) => fetcher.submit({ intent }, { method: "post" });
  const hasToken = Boolean(data.apiToken);
  const endpoint = `${data.appUrl}/api/extension/capture`;

  const copy = async (value: string, doneKey: "settings.advanced.tokenCopied" | "settings.advanced.endpointCopied") => {
    try {
      await navigator.clipboard.writeText(value);
      shopify.toast.show(t(doneKey));
    } catch {
      shopify.toast.show(t("settings.advanced.copyFailed"), { isError: true });
    }
  };

  // Generating the first token is the setup step, so it leads the page until it
  // is done. After that the merchant comes back to copy the token into another
  // computer's extension, not to replace it — rotating cuts off every extension
  // still holding the old one, so it stays a guarded button inside the card
  // rather than the most prominent thing on the screen.
  useSettingsPageAction(
    hasToken
      ? { content: t("settings.advanced.copyToken"), onAction: () => copy(data.apiToken ?? "", "settings.advanced.tokenCopied") }
      : { content: t("settings.advanced.generateToken"), onAction: () => submit("rotate-token"), loading: busyIntent === "rotate-token", disabled: busy && busyIntent !== "rotate-token" },
  );

  return (
    <Layout>
      {(actionMessage || failureMessage) && (
        <Layout.Section>
          {actionMessage && result?.ok && (
            <Banner tone="success">
              <p>{actionMessage}</p>
            </Banner>
          )}
          {failureMessage && (
            <Banner tone="critical" title={t("settings.advanced.failed")}>
              <p>{failureMessage}</p>
            </Banner>
          )}
        </Layout.Section>
      )}

      <Layout.AnnotatedSection title={t("settings.advanced.extension.title")} description={t("settings.advanced.extension.description")}>
        <Card>
          <FormLayout>
            <TextField
              label={t("settings.advanced.apiEndpoint")}
              value={endpoint}
              readOnly
              autoComplete="off"
              monospaced
              connectedRight={<Button icon={ClipboardIcon} accessibilityLabel={t("settings.advanced.copyEndpoint")} onClick={() => copy(endpoint, "settings.advanced.endpointCopied")} />}
            />
            <TextField
              label={t("settings.advanced.token")}
              value={data.apiToken ?? t("settings.advanced.tokenNotGenerated")}
              readOnly
              autoComplete="off"
              monospaced={hasToken}
              connectedRight={<Button icon={ClipboardIcon} accessibilityLabel={t("settings.advanced.copyToken")} onClick={() => copy(data.apiToken ?? "", "settings.advanced.tokenCopied")} disabled={!hasToken} />}
              helpText={hasToken ? t("settings.advanced.token.help") : t("settings.advanced.token.helpNone")}
            />
            {hasToken && (
              <Banner tone="warning" title={t("settings.advanced.rotateWarning.title")}>
                <p>{t("settings.advanced.rotateWarning.body")}</p>
              </Banner>
            )}
            {hasToken && (
              <InlineStack gap="200">
                <Button onClick={() => setConfirm("rotate")} loading={busyIntent === "rotate-token"} disabled={busy && busyIntent !== "rotate-token"}>
                  {t("settings.advanced.rotateToken")}
                </Button>
                <Button tone="critical" onClick={() => setConfirm("revoke")} loading={busyIntent === "revoke-token"} disabled={busy && busyIntent !== "revoke-token"}>
                  {t("settings.advanced.revokeToken")}
                </Button>
              </InlineStack>
            )}
            <Text as="p" tone="subdued" variant="bodySm">
              {t("settings.advanced.extension.helpBefore")} <code>Authorization: Bearer &lt;token&gt;</code> {t("settings.advanced.extension.helpAfter")}
            </Text>
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.advanced.system.title")} description={t("settings.advanced.system.description")}>
        <Card>
          <DescriptionList
            items={[
              {
                term: t("settings.advanced.supplierDriver"),
                description: <Badge tone={data.supplierDriver === "live" ? "success" : "attention"}>{data.supplierDriver}</Badge>,
              },
              {
                term: t("settings.advanced.tokenEncryption"),
                description: <Badge tone={data.encryption ? "success" : "warning"}>{data.encryption ? t("common.enabled") : t("common.disabled")}</Badge>,
              },
              {
                term: t("settings.advanced.email"),
                description: <Badge tone={data.emailProvider === "none" ? "attention" : "success"}>{data.emailProvider === "none" ? t("common.disabled") : data.emailProvider}</Badge>,
              },
              {
                term: t("settings.advanced.jobQueue"),
                description: (
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={data.queue.mode === "redis" ? "success" : "attention"}>{data.queue.mode}</Badge>
                    {data.queue.mode === "redis" && (
                      <Text as="span" tone="subdued" variant="bodySm" numeric>
                        {data.queue.waiting} {t("settings.advanced.queue.waiting")} · {data.queue.active} {t("settings.advanced.queue.active")} · {data.queue.delayed} {t("settings.advanced.queue.delayed")} · {data.queue.failed}{" "}
                        {t("settings.advanced.queue.failed")}
                      </Text>
                    )}
                  </InlineStack>
                ),
              },
            ]}
          />
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.advanced.rates.title")} description={`${data.supplierCurrency} → ${data.shopCurrency} ${t("settings.advanced.rates.description")}`}>
        <Card padding="0">
          <BlockStack gap="0">
            <Box padding="400">
              <InlineStack align="space-between" blockAlign="center" gap="200">
                <SectionHeader title={t("settings.advanced.rates.cached")} count={data.rates.length} />
                <Button onClick={() => submit("refresh-rates")} loading={busyIntent === "refresh-rates"} disabled={busy && busyIntent !== "refresh-rates"}>
                  {t("settings.advanced.rates.refresh")}
                </Button>
              </InlineStack>
            </Box>
            {data.rates.length === 0 ? (
              <EmptyScreen compact heading={t("settings.advanced.rates.empty")} body={t("settings.advanced.rates.emptyBody")} />
            ) : (
              <DataTable
                columnContentTypes={["text", "numeric", "text"]}
                headings={[t("settings.advanced.rates.currency"), t("settings.advanced.rates.rate"), t("settings.advanced.rates.fetched")]}
                rows={data.rates.map((r) => [
                  r.quote,
                  <Text as="span" key={`${r.quote}-rate`} numeric>
                    {r.rate}
                  </Text>,
                  formatDate(r.fetchedAt, dateLocale),
                ])}
              />
            )}
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.advanced.webhooks.title")} description={t("settings.advanced.webhooks.description")}>
        <Card padding="0">
          <BlockStack gap="0">
            <Box padding="400">
              <SectionHeader title={t("settings.advanced.webhooks.latest")} count={data.webhooks.length} />
            </Box>
            {data.webhooks.length === 0 ? (
              <EmptyScreen compact heading={t("settings.advanced.webhooks.empty")} body={t("settings.advanced.webhooks.emptyBody")} />
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "text"]}
                headings={[t("settings.advanced.webhooks.topic"), t("settings.advanced.webhooks.received"), t("common.status")]}
                rows={data.webhooks.map((w) => [
                  <Text as="span" key={`${w.id}-topic`} fontWeight="semibold">
                    {w.topic}
                  </Text>,
                  formatDate(w.createdAt, dateLocale),
                  w.error ? (
                    <Tooltip key={`${w.id}-status`} content={w.error}>
                      <Badge tone="critical">{t("common.error")}</Badge>
                    </Tooltip>
                  ) : w.processedAt ? (
                    <Badge key={`${w.id}-status`} tone="success">
                      {t("settings.advanced.webhooks.processed")}
                    </Badge>
                  ) : (
                    <Badge key={`${w.id}-status`} tone="attention">
                      {t("settings.advanced.webhooks.queued")}
                    </Badge>
                  ),
                ])}
              />
            )}
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "revoke" ? t("settings.advanced.revokeConfirm.title") : t("settings.advanced.rotateConfirm.title")}
        primaryAction={{
          content: confirm === "revoke" ? t("settings.advanced.revokeToken") : t("settings.advanced.rotateToken"),
          destructive: true,
          onAction: () => {
            submit(confirm === "revoke" ? "revoke-token" : "rotate-token");
            setConfirm(null);
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setConfirm(null) }]}
      >
        <Modal.Section>
          <Text as="p">{confirm === "revoke" ? t("settings.advanced.revokeConfirm.body") : t("settings.advanced.rotateConfirm.body")}</Text>
        </Modal.Section>
      </Modal>
    </Layout>
  );
}
