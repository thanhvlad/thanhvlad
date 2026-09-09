import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Badge, BlockStack, Button, Card, DescriptionList, InlineStack, Layout, List, Text } from "@shopify/polaris";
import { useSettingsPageAction } from "~/components/settings-page-action";
import { requireShop } from "~/lib/auth.server";
import { env } from "~/lib/env.server";
import { useT } from "~/lib/use-t";
import { emailProvider } from "~/services/email.server";
import { queueStats } from "~/services/jobs/index.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const config = env();
  const queue = await queueStats().catch(() => ({ mode: "inline" as const }));
  return {
    supportEmail: config.SUPPORT_EMAIL ?? null,
    appUrl: config.SHOPIFY_APP_URL,
    shopDomain: shop.domain,
    supplierDriver: config.SUPPLIER_DRIVER,
    queueMode: queue.mode,
    email: emailProvider(),
  };
};

export default function SupportSettings() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  const subject = encodeURIComponent(`[DropshipHub] ${data.shopDomain}`);
  const mailto = data.supportEmail ? `mailto:${data.supportEmail}?subject=${subject}` : null;

  useSettingsPageAction(mailto ? { content: t("settings.support.emailUs"), url: mailto, external: true } : null);

  return (
    <Layout>
      <Layout.AnnotatedSection title={t("settings.support.title")} description={t("settings.support.description")}>
        <Card>
          <BlockStack gap="300">
            <Text as="p">{t("settings.support.body")}</Text>
            <InlineStack gap="200" wrap>
              {mailto && (
                <Button variant="primary" url={mailto} external>
                  {t("settings.support.emailUs")}
                </Button>
              )}
              <Button url={`${data.appUrl}/support`} external target="_blank">
                {t("settings.support.helpCenter")}
              </Button>
              <Button url={`${data.appUrl}/privacy`} external target="_blank">
                {t("settings.support.privacy")}
              </Button>
              <Button url={`${data.appUrl}/terms`} external target="_blank">
                {t("settings.support.terms")}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.support.include.title")} description={t("settings.support.include.description")}>
        <Card>
          <List type="number">
            <List.Item>{t("settings.support.include.store", { store: data.shopDomain })}</List.Item>
            <List.Item>{t("settings.support.include.order")}</List.Item>
            <List.Item>{t("settings.support.include.screenshot")}</List.Item>
          </List>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.support.environment.title")} description={t("settings.support.environment.description")}>
        <Card>
          <DescriptionList
            items={[
              {
                term: t("settings.support.environment.store"),
                description: (
                  <Text as="span" fontWeight="semibold">
                    {data.shopDomain}
                  </Text>
                ),
              },
              {
                term: t("settings.advanced.supplierDriver"),
                description: <Badge tone={data.supplierDriver === "live" ? "success" : "attention"}>{data.supplierDriver}</Badge>,
              },
              {
                term: t("settings.advanced.jobQueue"),
                description: <Badge tone={data.queueMode === "redis" ? "success" : "attention"}>{data.queueMode}</Badge>,
              },
              {
                term: t("settings.advanced.email"),
                description: <Badge tone={data.email === "none" ? "attention" : "success"}>{data.email === "none" ? t("common.disabled") : data.email}</Badge>,
              },
            ]}
          />
        </Card>
      </Layout.AnnotatedSection>
    </Layout>
  );
}
