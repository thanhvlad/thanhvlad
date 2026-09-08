import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Badge, BlockStack, Button, Card, InlineStack, Layout, List, Text } from "@shopify/polaris";
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
  return (
    <Layout>
      <Layout.AnnotatedSection title={t("settings.support.title")} description={t("settings.support.description")}>
        <Card>
          <BlockStack gap="300">
            <Text as="p">{t("settings.support.body")}</Text>
            <InlineStack gap="200" wrap>
              {data.supportEmail && (
                <Button variant="primary" url={`mailto:${data.supportEmail}?subject=${subject}`} external>
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
          <BlockStack gap="300">
            <List>
              <List.Item>{t("settings.support.include.store", { store: data.shopDomain })}</List.Item>
              <List.Item>{t("settings.support.include.order")}</List.Item>
              <List.Item>{t("settings.support.include.screenshot")}</List.Item>
            </List>
            <InlineStack gap="200">
              <Text as="span">{t("settings.advanced.supplierDriver")}</Text>
              <Badge tone={data.supplierDriver === "live" ? "success" : "attention"}>{data.supplierDriver}</Badge>
              <Text as="span">{t("settings.advanced.jobQueue")}</Text>
              <Badge tone={data.queueMode === "redis" ? "success" : "attention"}>{data.queueMode}</Badge>
              <Text as="span">{t("settings.advanced.email")}</Text>
              <Badge tone={data.email === "none" ? "attention" : "success"}>{data.email === "none" ? t("common.disabled") : data.email}</Badge>
            </InlineStack>
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>
    </Layout>
  );
}
