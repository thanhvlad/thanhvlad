import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Layout,
  List,
  Modal,
  ProgressBar,
  Text,
  TextField,
} from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { SectionHeader } from "~/components/SectionHeader";
import { useSettingsPageAction } from "~/components/settings-page-action";
import { StatusBadge } from "~/components/StatusBadge";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate, relativeTime } from "~/lib/format";
import type { I18nKey } from "~/lib/i18n";
import { useErrorMessage, useLocale, useMessage, useT } from "~/lib/use-t";
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
  const { shop, graphql, actor } = await requireShop(request, { minRole: "ADMIN" });
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

/** Badge tone for a Shopify fulfilment request's own status. */
const REQUEST_TONES: Record<string, "success" | "critical" | "attention" | "info" | undefined> = {
  SUBMITTED: "info",
  AWAITING_APPROVAL: "attention",
  ACCEPTED: "success",
  REJECTED: "critical",
  CANCELLATION_REQUESTED: "attention",
  CANCELLED: undefined,
  CLOSED: undefined,
};

export default function FulfillmentServiceSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as
    | { ok?: boolean; message?: string; error?: string; errors?: string[]; tone?: "success" | "info" | "warning" | "critical" }
    | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(result as Parameters<typeof useErrorMessage>[0]);
  const { state } = data;
  const t = useT();
  const locale = useLocale();
  const dateLocale = locale === "vi" ? "vi-VN" : "en-US";
  const [confirmUnregister, setConfirmUnregister] = useState(false);
  const busy = fetcher.state !== "idle";
  const busyWith = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const coverage = state.totalVariants > 0 ? Math.round((state.assignedVariants / state.totalVariants) * 100) : 0;
  const submit = (intent: string) => fetcher.submit({ intent }, { method: "post" });

  // The one thing a merchant does here depends on where they are: register the
  // service first, then route products to it.
  useSettingsPageAction(
    state.registered
      ? { content: t("settings.fulfillmentService.routeAll"), onAction: () => submit("assign-all"), loading: busyWith === "assign-all", disabled: busy && busyWith !== "assign-all" }
      : { content: t("settings.fulfillmentService.register"), onAction: () => submit("register"), loading: busyWith === "register", disabled: busy && busyWith !== "register" },
  );

  return (
    <Layout>
      {(actionMessage || failureMessage) && (
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
          {failureMessage && (
            <Banner tone="critical" title={t("settings.fulfillmentService.rejected")}>
              <p>{failureMessage}</p>
            </Banner>
          )}
        </Layout.Section>
      )}

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
                  {t("settings.fulfillmentService.since")} {formatDate(state.registeredAt, dateLocale)}
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
                    <Text as="span" tone="subdued" numeric>
                      {state.assignedVariants}/{state.totalVariants} {t("settings.fulfillmentService.variantsCount")}
                    </Text>
                  </InlineStack>
                  <ProgressBar progress={coverage} size="small" />
                </BlockStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("settings.fulfillmentService.locationHelp")}
                </Text>
                <InlineStack>
                  <Button tone="critical" onClick={() => setConfirmUnregister(true)} loading={busyWith === "unregister"} disabled={busy && busyWith !== "unregister"}>
                    {t("settings.fulfillmentService.unregister")}
                  </Button>
                </InlineStack>
              </BlockStack>
            ) : (
              <BlockStack gap="300">
                <Text as="p">{t("settings.fulfillmentService.registerHelp")}</Text>
                <TextField label={t("settings.fulfillmentService.callbackUrl")} value={data.callbackUrl} readOnly autoComplete="off" monospaced />
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

      <Layout.Section>
        <Card padding="0">
          <BlockStack gap="0">
            <Box padding="400">
              <BlockStack gap="100">
                <SectionHeader title={t("settings.fulfillmentService.requests.title")} count={data.requests.length} />
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("settings.fulfillmentService.requests.description")}
                </Text>
              </BlockStack>
            </Box>
            {data.requests.length === 0 ? (
              <EmptyScreen compact heading={t("settings.fulfillmentService.requests.empty")} body={t("settings.fulfillmentService.requests.emptyBody")} />
            ) : (
              <IndexTable
                resourceName={{ singular: t("settings.fulfillmentService.requests.resource.singular"), plural: t("settings.fulfillmentService.requests.resource.plural") }}
                itemCount={data.requests.length}
                selectable={false}
                headings={[
                  { title: t("settings.fulfillmentService.requests.column.order") },
                  { title: t("settings.fulfillmentService.requests.column.request") },
                  { title: t("settings.fulfillmentService.requests.column.orderStage") },
                  { title: t("settings.fulfillmentService.requests.column.requested") },
                  { title: t("settings.fulfillmentService.requests.column.response") },
                ]}
              >
                {data.requests.map((r, index) => (
                  <IndexTable.Row id={r.id} key={r.id} position={index}>
                    <IndexTable.Cell>
                      <Link to={`/app/orders/${r.orderId}`}>
                        <Text as="span" fontWeight="semibold">
                          {r.orderName}
                        </Text>
                      </Link>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={REQUEST_TONES[r.status]}>{t(`settings.fulfillmentService.requests.status.${r.status}` as I18nKey) ?? r.status}</Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <StatusBadge status={r.orderStage} />
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {relativeTime(r.requestedAt)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" tone="subdued" variant="bodySm">
                        {r.responseMessage ?? (r.respondedAt ? formatDate(r.respondedAt, dateLocale) : "—")}
                      </Text>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </BlockStack>
        </Card>
      </Layout.Section>

      <Modal
        open={confirmUnregister}
        onClose={() => setConfirmUnregister(false)}
        title={t("settings.fulfillmentService.unregisterConfirm.title")}
        primaryAction={{
          content: t("settings.fulfillmentService.unregister"),
          destructive: true,
          loading: busyWith === "unregister",
          onAction: () => {
            submit("unregister");
            setConfirmUnregister(false);
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setConfirmUnregister(false) }]}
      >
        <Modal.Section>
          <Text as="p">{t("settings.fulfillmentService.unregisterConfirm.body")}</Text>
        </Modal.Section>
      </Modal>
    </Layout>
  );
}
