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
        return { ok: true, message: `Registered. Shopify created the location "${service.locationName ?? service.locationId}".` };
      }
      case "unregister":
        await unregisterFulfillmentService(shop, graphql, actor);
        return { ok: true, message: "Fulfilment service removed." };
      case "assign-all": {
        const products = await prisma.product.findMany({ where: { shopId: shop.id }, select: { id: true } });
        const result = await assignProductsToService(shop, graphql, products.map((p) => p.id), actor);
        return {
          ok: true,
          message: `${result.assigned} of ${result.total} variant(s) stocked at the app's location.`,
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
  const result = fetcher.data as { message?: string; error?: string; errors?: string[] } | undefined;
  const { state } = data;
  const coverage = state.totalVariants > 0 ? Math.round((state.assignedVariants / state.totalVariants) * 100) : 0;

  return (
    <Layout>
      <Layout.Section>
        {result?.message && (
          <Banner tone="success">
            <p>{result.message}</p>
            {result.errors?.length ? (
              <List>
                {result.errors.map((e) => (
                  <List.Item key={e}>{e}</List.Item>
                ))}
              </List>
            ) : null}
          </Banner>
        )}
        {result?.error && (
          <Banner tone="critical" title="Shopify rejected the request">
            <p>{result.error}</p>
          </Banner>
        )}
      </Layout.Section>

      <Layout.AnnotatedSection
        title="Request fulfillment button"
        description="Register the app as a Shopify fulfilment service so every order gets a native Request fulfillment button that sends the order straight here."
      >
        <Card>
          <BlockStack gap="400">
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" fontWeight="semibold">
                Status
              </Text>
              <Badge tone={state.registered ? "success" : undefined}>{state.registered ? "Registered" : "Not registered"}</Badge>
              {state.registeredAt && (
                <Text as="span" tone="subdued" variant="bodySm">
                  since {formatDate(state.registeredAt)}
                </Text>
              )}
            </InlineStack>

            {state.registered ? (
              <BlockStack gap="300">
                <Text as="p" tone="subdued">
                  Shopify location: <strong>{state.locationName ?? state.locationId}</strong>
                </Text>
                <BlockStack gap="100">
                  <InlineStack align="space-between">
                    <Text as="span">Products routed to the app</Text>
                    <Text as="span" tone="subdued">
                      {state.assignedVariants}/{state.totalVariants} variants
                    </Text>
                  </InlineStack>
                  <ProgressBar progress={coverage} size="small" />
                </BlockStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Only products stocked at that location show the button. Assign your managed products, then open any order in
                  Shopify — you will see Request fulfillment next to the items.
                </Text>
                <InlineStack gap="200">
                  <Button variant="primary" onClick={() => fetcher.submit({ intent: "assign-all" }, { method: "post" })} loading={fetcher.state !== "idle"}>
                    Route all my products to the app
                  </Button>
                  <Button tone="critical" onClick={() => fetcher.submit({ intent: "unregister" }, { method: "post" })}>
                    Unregister
                  </Button>
                </InlineStack>
              </BlockStack>
            ) : (
              <BlockStack gap="300">
                <Text as="p">
                  Registering creates a Shopify location owned by this app. Nothing else changes until you assign products to
                  it, and you can unregister at any time.
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Callback URL Shopify will be given: <code>{data.callbackUrl}</code>
                </Text>
                <Box>
                  <Button variant="primary" onClick={() => fetcher.submit({ intent: "register" }, { method: "post" })} loading={fetcher.state !== "idle"}>
                    Register fulfilment service
                  </Button>
                </Box>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="How it behaves" description="What the app does when a merchant presses the button.">
        <Card>
          <List type="number">
            <List.Item>Shopify sends the fulfilment request to the app.</List.Item>
            <List.Item>
              The app re-checks the order: address validity, mapping, stock and payment. If a variant is not mapped it{" "}
              <strong>rejects</strong> the request with the reason, so the merchant sees it in Shopify instead of silence.
            </List.Item>
            <List.Item>Otherwise it accepts, places the supplier order, and the order moves to Awaiting payment.</List.Item>
            <List.Item>
              You pay on the supplier site from <Link to="/app/payments">Payments</Link>; tracking is pushed back to Shopify
              automatically once the supplier ships.
            </List.Item>
            <List.Item>A cancellation request is accepted automatically while nothing has shipped yet.</List.Item>
          </List>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title="Recent requests" description="Fulfilment requests Shopify has sent to the app.">
        <Card>
          {data.requests.length === 0 ? (
            <Text as="p" tone="subdued">
              No requests yet.
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
