import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  List,
  ProgressBar,
  Text,
} from "@shopify/polaris";
import { StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, relativeTime } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
import prisma from "~/db.server";
import {
  assignProductsToService,
  callbackUrl,
  getFulfillmentServiceState,
  listFulfillmentRequests,
  registerFulfillmentService,
  unregisterFulfillmentService,
} from "~/services/fulfillment-service.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, graphql } = await requireShop(request);
  const [state, requests] = await Promise.all([
    getFulfillmentServiceState(shop, graphql),
    listFulfillmentRequests(shop.id, { limit: 20 }),
  ]);
  return {
    state,
    callbackUrl: callbackUrl(),
    requests: requests.map((r) => ({
      id: r.id,
      orderId: r.order.id,
      orderName: r.order.name,
      orderStage: r.order.stage,
      status: r.status,
      requestedAt: r.requestedAt,
      respondedAt: r.respondedAt,
      responseMessage: r.responseMessage,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, graphql, actor } = await requireShop(request);
  const { intent } = await readForm(request);
  try {
    switch (intent) {
      case "register": {
        const service = await registerFulfillmentService(shop, graphql, actor);
        return { ok: true, messageKey: "msg.fulfillmentServiceRegistered", messageVars: { location: String(service.locationName ?? service.locationId) } };
      }
      case "unregister":
        await unregisterFulfillmentService(shop, graphql, actor);
        return { ok: true, messageKey: "msg.fulfillmentServiceRemoved" };
      case "assign-all": {
        const products = await prisma.product.findMany({ where: { shopId: shop.id }, select: { id: true } });
        const result = await assignProductsToService(shop, graphql, products.map((p) => p.id), actor);
        // The banner used to read "success" even when nothing was stocked, which
        // told a merchant their orders would route here when none of them would.
        const nothingToDo = result.total === 0;
        const tone = nothingToDo ? "info" : result.assigned === 0 ? "critical" : result.errors.length ? "warning" : "success";
        return {
          ok: true,
          tone,
          messageKey: nothingToDo
            ? "msg.noManagedVariants"
            : result.assigned === 0
              ? "msg.noVariantsStocked"
              : "msg.variantsStocked",
          messageVars: { n: result.assigned, total: result.total },
          errors: result.errors.slice(0, 8),
        };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function FulfillmentServiceSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as
    | { message?: string; error?: string; errors?: string[]; tone?: "success" | "info" | "warning" | "critical" }
    | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const { state } = data;
  const t = useT();
  const coverage = state.totalVariants > 0 ? Math.round((state.assignedVariants / state.totalVariants) * 100) : 0;

  return (
    <Layout>
      <Layout.Section>
        {actionMessage && (
          <Banner tone={result?.tone ?? "success"}>
            <p>{actionMessage}</p>
            {result?.errors?.length ? (
              <List>
                {result.errors!.map((e) => (
                  <List.Item key={e}>{e}</List.Item>
                ))}
              </List>
            ) : null}
          </Banner>
        )}
        {result?.error && (
          <Banner tone="critical" title={t("settings.fulfillmentService.rejected")}>
            <p>{result.error}</p>
          </Banner>
        )}
      </Layout.Section>

      <Layout.AnnotatedSection title={t("settings.fulfillmentService.title")} description={t("settings.fulfillmentService.description")}>
        <Card>
          <BlockStack gap="400">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" fontWeight="semibold">
                {t("common.status")}
              </Text>
              <Badge tone={state.registered ? "success" : undefined}>{state.registered ? t("settings.fulfillmentService.registered") : t("settings.fulfillmentService.notRegistered")}</Badge>
              {state.registeredAt && (
                <Text as="span" tone="subdued" variant="bodySm">
                  {t("settings.fulfillmentService.since")} {formatDate(state.registeredAt)}
                </Text>
              )}
            </InlineStack>

            {state.registered ? (
              <BlockStack gap="300">
                <Text as="p" tone="subdued">
                  {t("settings.fulfillmentService.location")}: <strong>{state.locationName ?? state.locationId}</strong>
                </Text>
                <BlockStack gap="100">
                  <InlineStack align="space-between">
                    <Text as="span">{t("settings.fulfillmentService.productsRouted")}</Text>
                    <Text as="span" tone="subdued">
                      {state.assignedVariants}/{state.totalVariants} {t("settings.fulfillmentService.variantsCount")}
                    </Text>
                  </InlineStack>
                  <ProgressBar progress={coverage} size="small" />
                </BlockStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("settings.fulfillmentService.locationHelp")}
                </Text>
                <InlineStack gap="200">
                  <Button variant="primary" onClick={() => fetcher.submit({ intent: "assign-all" }, { method: "post" })} loading={fetcher.state !== "idle"}>
                    {t("settings.fulfillmentService.routeAll")}
                  </Button>
                  <Button tone="critical" onClick={() => fetcher.submit({ intent: "unregister" }, { method: "post" })}>
                    {t("settings.fulfillmentService.unregister")}
                  </Button>
                </InlineStack>
              </BlockStack>
            ) : (
              <BlockStack gap="300">
                <Text as="p">{t("settings.fulfillmentService.registerHelp")}</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("settings.fulfillmentService.callbackUrl")}: <code>{data.callbackUrl}</code>
                </Text>
                <Box>
                  <Button variant="primary" onClick={() => fetcher.submit({ intent: "register" }, { method: "post" })} loading={fetcher.state !== "idle"}>
                    {t("settings.fulfillmentService.register")}
                  </Button>
                </Box>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.fulfillmentService.how.title")} description={t("settings.fulfillmentService.how.description")}>
        <Card>
          <List type="number">
            <List.Item>{t("settings.fulfillmentService.how.step1")}</List.Item>
            <List.Item>
              {t("settings.fulfillmentService.how.step2Before")} <strong>{t("settings.fulfillmentService.how.step2Rejects")}</strong> {t("settings.fulfillmentService.how.step2After")}
            </List.Item>
            <List.Item>{t("settings.fulfillmentService.how.step3")}</List.Item>
            <List.Item>
              {t("settings.fulfillmentService.how.step4Before")} <Link to="/app/payments">{t("nav.payments")}</Link>
              {t("settings.fulfillmentService.how.step4After")}
            </List.Item>
            <List.Item>{t("settings.fulfillmentService.how.step5")}</List.Item>
          </List>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.fulfillmentService.requests.title")} description={t("settings.fulfillmentService.requests.description")}>
        <Card>
          {data.requests.length === 0 ? (
            <Text as="p" tone="subdued">
              {t("settings.fulfillmentService.requests.empty")}
            </Text>
          ) : (
            <BlockStack gap="200">
              {data.requests.map((r) => (
                <Box key={r.id} padding="200" borderColor="border" borderWidth="025" borderRadius="200">
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <InlineStack gap="200" blockAlign="center">
                      <Link to={`/app/orders/${r.orderId}`}>{r.orderName}</Link>
                      <Badge tone={r.status === "ACCEPTED" ? "success" : r.status === "REJECTED" ? "critical" : undefined}>{r.status}</Badge>
                      <StatusBadge status={r.orderStage} />
                    </InlineStack>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {relativeTime(r.requestedAt)}
                      {r.responseMessage ? ` · ${r.responseMessage}` : ""}
                    </Text>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          )}
        </Card>
      </Layout.AnnotatedSection>
    </Layout>
  );
}
