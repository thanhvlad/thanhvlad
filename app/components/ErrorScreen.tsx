import { useRevalidator } from "@remix-run/react";
import { Banner, BlockStack, Layout, Page, Text } from "@shopify/polaris";
import { useT } from "~/lib/use-t";
import { summarizeRouteError } from "./route-error";

/**
 * The one error screen.
 *
 * Before this, a loader or action that threw replaced the whole app — navigation
 * included — with whatever `boundary.error` made of it: the bare text
 * "Not found", a role message with no way back, or Remix's unstyled
 * "Application Error". A reviewer reads that as a broken app. This is a normal
 * Polaris page that says what happened in the merchant's language, what to do
 * about it, and offers the two ways out: try again, or go home.
 */
export function ErrorScreen({ error }: { error: unknown }) {
  const t = useT();
  const revalidator = useRevalidator();
  const summary = summarizeRouteError(error);

  return (
    <Page title={t(`errorScreen.${summary.kind}.title`)}>
      <Layout>
        <Layout.Section>
          <Banner
            tone={summary.kind === "unexpected" ? "critical" : "warning"}
            title={summary.status ? t("errorScreen.status", { status: summary.status }) : undefined}
            action={
              summary.kind === "unexpected"
                ? { content: t("errorScreen.retry"), onAction: () => revalidator.revalidate(), loading: revalidator.state !== "idle" }
                : undefined
            }
            secondaryAction={{ content: t("errorScreen.home"), url: "/app" }}
          >
            <BlockStack gap="200">
              <p>{t(`errorScreen.${summary.kind}.body`)}</p>
              {summary.detail && (
                <Text as="p" tone="subdued">
                  {summary.detail}
                </Text>
              )}
            </BlockStack>
          </Banner>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
