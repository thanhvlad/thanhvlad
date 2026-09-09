import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Link, useFetcher, useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  FormLayout,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  Link as PolarisLink,
  List,
  Modal,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { SectionHeader } from "~/components/SectionHeader";
import { Stat } from "~/components/Stat";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import type { ResolveResult } from "~/domain/mapping/types";
import { FAILURE_LABELS } from "~/domain/mapping/resolve";
import type { ShippingAddress } from "~/domain/orders/address";
import type { OrderIssue } from "~/domain/orders/pipeline";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { adminUrl, formatDate, formatMoney, legacyId } from "~/lib/format";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
import { addManualTracking, cancelPurchaseOrder, markPurchaseOrderManual, placeSupplierOrders, retryPurchaseOrder, syncPendingTracking, syncPurchaseOrder } from "~/services/fulfillment.server";
import { evaluateAndStoreOrder, getOrderDetail, refreshOrderFromShopify, setLineItemIgnored, updateOrderAddress } from "~/services/orders.server";
import { listActivity } from "~/services/activity.server";
import { getComparison } from "~/services/supplier-comparison.server";
import { approveFulfillmentRequest, declineFulfillmentRequest, pendingApproval } from "~/services/fulfillment-service.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const order = await getOrderDetail(shop.id, params.id!);
  if (!order) throw new Response("Not found", { status: 404 });
  const activity = await listActivity(shop.id, { entity: "Order", entityId: order.id, limit: 20 });

  // A better supplier is only useful where the decision is actually taken, and
  // that is here — looking at an order that has not been placed yet. Read from
  // the stored comparison only; nothing goes upstream while a merchant is
  // merely looking at an order.
  const managedProductIds = [
    ...new Set(order.lineItems.filter((li) => !li.isCanceled && !li.isFulfilled).map((li) => li.productVariant?.product.id).filter(Boolean)),
  ].slice(0, 10) as string[];
  const alternatives: Record<string, {
    supplierProductId: string;
    title: string;
    platform: string;
    url: string | null;
    landedCost: string;
    currency: string;
    deliveryDays: number | null;
    savings: string | null;
    savingsPercent: number | null;
    coverage: string;
  }> = {};
  for (const productId of managedProductIds) {
    const comparison = await getComparison(shop, productId).catch(() => null);
    const better = comparison?.betterOption;
    if (!better) continue;
    alternatives[productId] = {
      supplierProductId: better.supplierProductId,
      title: better.title,
      platform: better.platform,
      url: better.url,
      landedCost: better.landedCost,
      currency: better.currency,
      deliveryDays: better.deliveryDays,
      savings: better.savingsVsCurrent,
      savingsPercent: better.savingsPercent,
      coverage: `${better.matchedVariants}/${better.totalVariants}`,
    };
  }

  const approval = await pendingApproval(shop.id, order.id);

  return {
    shopDomain: shop.domain,
    currency: shop.currency,
    alternatives,
    approval,
    order: {
      id: order.id,
      name: order.name,
      shopifyOrderId: order.shopifyOrderId,
      stage: order.stage,
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      createdAt: order.shopifyCreatedAt,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      phone: order.phone,
      address: order.shippingAddress as ShippingAddress,
      total: order.totalPrice.toString(),
      shipping: order.totalShipping.toString(),
      supplierCost: order.supplierCost.toString(),
      supplierShipping: order.supplierShipping.toString(),
      tags: order.tags,
      note: order.note,
      riskLevel: order.riskLevel,
      issues: (order.issues as unknown as OrderIssue[]) ?? [],
      lineItems: order.lineItems.map((li) => ({
        id: li.id,
        title: li.title,
        variantTitle: li.variantTitle,
        sku: li.sku,
        image: li.image,
        quantity: li.quantity,
        fulfillable: li.fulfillableQuantity,
        price: li.price.toString(),
        managed: Boolean(li.productVariantId),
        productId: li.productVariant?.product.id ?? null,
        isCanceled: li.isCanceled,
        isFulfilled: li.isFulfilled,
        resolution: (li.resolution as unknown as ResolveResult | null) && "ok" in (li.resolution as object) ? (li.resolution as unknown as ResolveResult) : null,
      })),
      purchaseOrders: order.purchaseOrders.map((po) => ({
        id: po.id,
        platform: po.platform,
        account: po.supplierAccount?.label ?? null,
        externalOrderId: po.externalOrderId,
        status: po.status,
        itemsCost: po.itemsCost.toString(),
        shippingCost: po.shippingCost.toString(),
        totalCost: po.totalCost.toString(),
        currency: po.currency,
        carrierName: po.carrierName,
        estimatedDays: po.estimatedDeliveryDays,
        errorMessage: po.errorMessage,
        placedAt: po.placedAt,
        paymentUrl: (po.raw as { paymentUrl?: string } | null)?.paymentUrl ?? null,
        items: po.items.map((i) => ({ id: i.id, title: i.title, quantity: i.quantity, unitCost: i.unitCost.toString(), externalSkuId: i.externalSkuId })),
        trackings: po.trackings.map((t) => ({ id: t.id, number: t.number, carrier: t.carrierName ?? t.carrierCode, url: t.trackingUrl, synced: t.syncedToShopify, syncError: t.syncError, status: t.status })),
      })),
    },
    activity: activity.map((a) => ({ id: a.id, at: a.createdAt, message: a.message, level: a.level, actor: a.actor })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { shop, graphql, actor } = await requireShop(request);
  const { intent, get } = await readForm(request);
  const id = params.id!;
  try {
    switch (intent) {
      case "place": {
        const outcome = await placeSupplierOrders(shop, id, { actor, force: get("force") === "true" });
        return outcome.ok ? { ok: true, messageKey: "msg.supplierOrdersPlaced", messageVars: { n: outcome.purchaseOrderIds.length } } : { ok: false, error: outcome.error, issues: outcome.issues };
      }
      case "approve-fulfillment": {
        const outcome = await approveFulfillmentRequest(shop, get("requestId"), actor);
        return outcome.ok
          ? { ok: true, messageKey: "msg.fulfillmentApproved" }
          : { ok: false, error: outcome.error, issues: outcome.issues };
      }
      case "decline-fulfillment": {
        const outcome = await declineFulfillmentRequest(shop, get("requestId"), get("reason"), actor);
        return outcome.ok ? { ok: true, messageKey: "msg.fulfillmentDeclined" } : { ok: false, error: outcome.error };
      }
      case "re-evaluate":
        await evaluateAndStoreOrder(shop, id);
        return { ok: true, messageKey: "msg.orderRechecked" };
      case "refresh": {
        const order = await getOrderDetail(shop.id, id);
        if (order) await refreshOrderFromShopify(shop, graphql, order.shopifyOrderId);
        return { ok: true, messageKey: "msg.refreshedFromShopify" };
      }
      case "save-address": {
        await updateOrderAddress(
          shop,
          graphql,
          id,
          {
            firstName: get("firstName"), lastName: get("lastName"), name: `${get("firstName")} ${get("lastName")}`.trim(), company: get("company"),
            address1: get("address1"), address2: get("address2"), city: get("city"), province: get("province"), provinceCode: get("provinceCode"), zip: get("zip"),
            countryCode: get("countryCode").toUpperCase(), phone: get("phone"), taxNumber: get("taxNumber"),
          },
          { pushToShopify: get("pushToShopify") === "true" },
          actor,
        );
        return { ok: true, messageKey: "msg.addressSaved" };
      }
      case "ignore-line":
        await setLineItemIgnored(shop, id, get("lineItemId"), get("ignored") === "true");
        return { ok: true, messageKey: "msg.lineItemUpdated" };
      case "sync-po": {
        const result = await syncPurchaseOrder(shop, get("purchaseOrderId"));
        return result.newTracking
          ? { ok: true, messageKey: "msg.supplierSaysWithTracking", messageVars: { status: result.status, n: result.newTracking } }
          : { ok: true, messageKey: "msg.supplierSays", messageVars: { status: result.status } };
      }
      case "retry-po": {
        const outcome = await retryPurchaseOrder(shop, get("purchaseOrderId"), actor);
        return outcome.ok ? { ok: true, messageKey: "msg.retried" } : { ok: false, error: outcome.error };
      }
      case "cancel-po": {
        const result = await cancelPurchaseOrder(shop, get("purchaseOrderId"), get("reason") || undefined, actor);
        return { ok: true, message: result.upstream ? "Canceled at the supplier." : "Canceled locally; cancel manually at the supplier if needed." };
      }
      case "manual-po":
        await markPurchaseOrderManual(shop, get("purchaseOrderId"), get("externalOrderId"), actor);
        return { ok: true, messageKey: "msg.supplierOrderLinked" };
      case "add-tracking":
        await addManualTracking(shop, get("purchaseOrderId"), { number: get("number"), carrierName: get("carrier") || null, url: get("url") || null }, actor);
        return { ok: true, messageKey: "msg.trackingAdded" };
      case "sync-tracking": {
        const result = await syncPendingTracking(shop, get("purchaseOrderId") || undefined, graphql);
        return result.failed
          ? { ok: true, messageKey: "msg.trackingSyncedWithFailures", messageVars: { n: result.synced, failed: result.failed } }
          : { ok: true, messageKey: "msg.trackingSynced", messageVars: { n: result.synced } };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

/**
 * "Saved." level outcomes go to a toast; anything a merchant needs to read
 * (a supplier's reply, a placed order, a failure) stays in the banner.
 */
const TOAST_KEYS = new Set(["msg.addressSaved", "msg.lineItemUpdated", "msg.trackingAdded", "msg.supplierOrderLinked", "msg.orderRechecked", "msg.refreshedFromShopify", "msg.retried"]);

/**
 * The banner's tone, from the outcome rather than from the fact that something
 * happened. "12 synced, 3 failed" is not a success, and a declined fulfilment
 * is not one either; both used to render green.
 */
function toneFor(messageKey: string | undefined): "success" | "info" | "warning" {
  if (messageKey === "msg.trackingSyncedWithFailures") return "warning";
  if (messageKey === "msg.fulfillmentDeclined") return "info";
  return "success";
}

type ActionResult = { ok?: boolean; message?: string; messageKey?: string; messageVars?: Record<string, string | number>; error?: string; issues?: string[] };

export default function OrderDetailPage() {
  const t = useT();
  const shopify = useAppBridge();
  const { order, activity, currency, shopDomain, alternatives, approval } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as ActionResult | undefined;
  const actionMessage = useMessage(result);
  const errorText = useErrorMessage(result);
  const quiet = Boolean(result?.ok && result.messageKey && TOAST_KEYS.has(result.messageKey));

  const [confirmSend, setConfirmSend] = useState(false);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState<Record<string, string>>({
    firstName: order.address.firstName ?? "", lastName: order.address.lastName ?? "", company: order.address.company ?? "", address1: order.address.address1 ?? "", address2: order.address.address2 ?? "",
    city: order.address.city ?? "", province: order.address.province ?? "", provinceCode: order.address.provinceCode ?? "", zip: order.address.zip ?? "", countryCode: order.address.countryCode ?? "", phone: order.address.phone ?? order.phone ?? "", taxNumber: order.address.taxNumber ?? "",
  });
  const [pushToShopify, setPushToShopify] = useState(false);
  const [linkPo, setLinkPo] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const [trackingPo, setTrackingPo] = useState<string | null>(null);
  const [tracking, setTracking] = useState({ number: "", carrier: "", url: "" });
  const [cancelPo, setCancelPo] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");

  const errors = order.issues.filter((i) => i.severity === "error");
  const warnings = order.issues.filter((i) => i.severity === "warning");
  const canPlace = order.stage === "AWAITING_ORDER" || order.stage === "PENDING" || order.stage === "FAILED";
  const force = order.stage === "PENDING";
  const busy = fetcher.state !== "idle";
  const submit = (payload: Record<string, string>) => fetcher.submit(payload, { method: "post" });

  useEffect(() => {
    // No `fetcher.state === "idle"` guard: the data lands while the fetcher is
    // still revalidating, so the guard was never true when this ran and the
    // quiet outcomes - saved address, ignored line, added tracking - gave the
    // merchant no feedback at all.
    if (quiet && actionMessage) shopify.toast.show(actionMessage);
    // Fire once per action result; `fetcher.data` is a new object per submission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const supplierTotal = Number(order.supplierCost) + Number(order.supplierShipping);
  const profit = Number(order.total) - supplierTotal;
  const margin = Number(order.total) > 0 ? Math.round((profit / Number(order.total)) * 1000) / 10 : 0;
  const priced = supplierTotal > 0;

  const addressName = order.address.name ?? [order.address.firstName, order.address.lastName].filter(Boolean).join(" ");

  return (
    <Page
      backAction={{ url: "/app/orders" }}
      title={order.name}
      titleMetadata={<StatusBadge status={order.stage} />}
      subtitle={`${formatDate(order.createdAt)} · ${order.customerName ?? order.customerEmail ?? ""}`}
      primaryAction={{
        content: force && errors.length ? t("orders.detail.placeAnyway") : t("orders.detail.action.sendToSupplier"),
        disabled: !canPlace,
        loading: busy,
        onAction: () => setConfirmSend(true),
      }}
      secondaryActions={[
        { content: t("orders.detail.openInShopify"), url: adminUrl(shopDomain, `/orders/${legacyId(order.shopifyOrderId)}`), external: true },
        { content: t("orders.detail.refreshFromShopify"), loading: busy, onAction: () => submit({ intent: "refresh" }) },
        { content: t("orders.detail.recheck"), loading: busy, onAction: () => submit({ intent: "re-evaluate" }) },
        { content: t("orders.detail.syncTracking"), loading: busy, onAction: () => submit({ intent: "sync-tracking" }) },
      ]}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionMessage && !quiet && (
              <Banner tone={toneFor(result?.messageKey)}>
                <p>{actionMessage}</p>
              </Banner>
            )}
            {errorText && (
              <Banner tone="critical" title={errorText}>
                {result?.issues?.length ? (
                  <List>
                    {result.issues.map((i) => (
                      <List.Item key={i}>{i}</List.Item>
                    ))}
                  </List>
                ) : null}
              </Banner>
            )}
            {errors.length > 0 && (
              <Banner tone="critical" title={t("orders.detail.blockedTitle")}>
                <List>
                  {errors.map((i, idx) => (
                    <List.Item key={idx}>{i.message}</List.Item>
                  ))}
                </List>
              </Banner>
            )}
            {warnings.length > 0 && (
              <Banner tone="warning" title={t("orders.detail.warningsTitle")}>
                <List>
                  {warnings.map((i, idx) => (
                    <List.Item key={idx}>{i.message}</List.Item>
                  ))}
                </List>
              </Banner>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="400">
            {approval && (
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center" align="space-between">
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone="attention">{t("orders.detail.awaitingApproval")}</Badge>
                      <Text as="h2" variant="headingMd">
                        {t("orders.detail.approvalTitle")}
                      </Text>
                    </InlineStack>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {t("orders.detail.approvalRequested")} {formatDate(approval.requestedAt)}
                    </Text>
                  </InlineStack>
                  <Text as="p" tone="subdued">
                    {t("orders.detail.approvalHelp")}
                  </Text>
                  {approval.requestMessage && (
                    <Text as="p" variant="bodySm">
                      “{approval.requestMessage}”
                    </Text>
                  )}

                  {approval.quote ? (
                    <BlockStack gap="200">
                      {approval.quote.lines.map((line, idx) => (
                        <InlineStack key={idx} align="space-between" blockAlign="center" wrap={false}>
                          <Text as="span" variant="bodySm">
                            {line.quantity} × {line.title.slice(0, 60)}{" "}
                            <PlatformBadge platform={line.platform} />
                            {line.carrierName ? (
                              <Text as="span" tone="subdued" variant="bodySm">
                                {" "}
                                · {line.carrierName}
                                {line.estimatedDeliveryDays ? ` ~${line.estimatedDeliveryDays} ${t("common.days")}` : ""}
                              </Text>
                            ) : null}
                          </Text>
                          <Text as="span" variant="bodySm" numeric>
                            {formatMoney(line.lineCost, approval.quote!.currency)}
                            {Number(line.shippingCost) > 0 ? ` + ${formatMoney(line.shippingCost, approval.quote!.currency)}` : ""}
                          </Text>
                        </InlineStack>
                      ))}
                      <Divider />
                      <InlineGrid columns={{ xs: 1, md: 3 }} gap="200">
                        <Stat plain size="medium" label={t("orders.detail.supplierItems")} value={formatMoney(approval.quote.itemsCost, approval.quote.currency)} />
                        <Stat plain size="medium" label={t("orders.detail.supplierShipping")} value={formatMoney(approval.quote.shippingCost, approval.quote.currency)} />
                        <Stat plain size="medium" label={t("orders.detail.youWillPay")} value={formatMoney(approval.quote.totalCost, approval.quote.currency)} />
                      </InlineGrid>
                      {approval.quote.unpriced.length > 0 && (
                        <Banner tone="warning" title={t("orders.detail.partialQuote")}>
                          <List>
                            {approval.quote.unpriced.map((u, idx) => (
                              <List.Item key={idx}>{u}</List.Item>
                            ))}
                          </List>
                        </Banner>
                      )}
                    </BlockStack>
                  ) : (
                    <Banner tone="warning" title={t("orders.detail.noQuote")}>
                      <p>{approval.quoteError ?? t("orders.detail.noQuoteReason")}</p>
                    </Banner>
                  )}

                  <InlineStack gap="200">
                    <Button variant="primary" loading={busy} onClick={() => submit({ intent: "approve-fulfillment", requestId: approval.id })}>
                      {t("orders.detail.approveAndSend")}
                    </Button>
                    <Button tone="critical" loading={busy} onClick={() => submit({ intent: "decline-fulfillment", requestId: approval.id, reason: declineReason })}>
                      {t("orders.detail.decline")}
                    </Button>
                  </InlineStack>
                  <TextField label={t("orders.detail.declineReason")} labelHidden autoComplete="off" placeholder={t("orders.detail.declineReason")} value={declineReason} onChange={setDeclineReason} />
                </BlockStack>
              </Card>
            )}

            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <SectionHeader title={t("orders.detail.items")} count={order.lineItems.length} />
              </Box>
              <IndexTable
                resourceName={{ singular: t("orders.detail.items"), plural: t("orders.detail.items") }}
                itemCount={order.lineItems.length}
                selectable={false}
                headings={[
                  { title: t("orders.detail.column.product") },
                  { title: t("common.quantity"), alignment: "end" },
                  { title: t("common.price"), alignment: "end" },
                  { title: t("orders.detail.column.lineTotal"), alignment: "end" },
                  { title: t("orders.detail.column.supplierMapping") },
                  { title: "" },
                ]}
              >
                {order.lineItems.map((li, index) => {
                  const alt = li.productId ? alternatives[li.productId] : undefined;
                  return (
                    <IndexTable.Row id={li.id} key={li.id} position={index} tone={li.isCanceled ? "subdued" : undefined}>
                      <IndexTable.Cell>
                        <InlineStack gap="300" blockAlign="center" wrap={false}>
                          <Thumb src={li.image} alt={li.title} />
                          <BlockStack gap="050">
                            <Text as="span" fontWeight="semibold">
                              {li.title}
                            </Text>
                            <InlineStack gap="100" blockAlign="center" wrap>
                              {li.variantTitle && (
                                <Text as="span" tone="subdued" variant="bodySm">
                                  {li.variantTitle}
                                </Text>
                              )}
                              {li.sku && (
                                <Text as="span" tone="subdued" variant="bodySm">
                                  SKU {li.sku}
                                </Text>
                              )}
                              {li.isFulfilled && <Badge tone="success">{t("stage.FULFILLED")}</Badge>}
                              {li.isCanceled && <Badge>{t("orders.detail.ignored")}</Badge>}
                              {!li.managed && <Badge tone="attention">{t("orders.notManaged")}</Badge>}
                            </InlineStack>
                          </BlockStack>
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end">
                          {String(li.quantity)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end">
                          {formatMoney(li.price, currency)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" numeric alignment="end">
                          {formatMoney(Number(li.price) * li.quantity, currency)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="100">
                          {!li.managed && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              {t("orders.detail.noMapping")}
                            </Text>
                          )}
                          {li.managed && li.resolution && (
                            li.resolution.ok ? (
                              li.resolution.lines.map((l) => (
                                <InlineStack key={l.mappingRowId} gap="100" blockAlign="center" wrap>
                                  <Text as="span" variant="bodySm">
                                    {l.quantity} × {l.title.slice(0, 70)}
                                  </Text>
                                  <Text as="span" variant="bodySm" numeric>
                                    {formatMoney(l.unitCost, l.currency)}
                                  </Text>
                                  <PlatformBadge platform={l.platform} />
                                </InlineStack>
                              ))
                            ) : (
                              <BlockStack gap="050">
                                <Text as="span" tone="critical" variant="bodySm">
                                  {li.resolution.failure ? FAILURE_LABELS[li.resolution.failure] : t("orders.detail.unresolved")}: {li.resolution.reason}
                                </Text>
                                {li.productId && <Link to={`/app/products/${li.productId}`}>{t("orders.detail.fixMapping")}</Link>}
                              </BlockStack>
                            )
                          )}
                          {alt && (
                            <Box padding="200" background="bg-surface-info" borderRadius="200">
                              <BlockStack gap="050">
                                <Text as="p" variant="bodySm" fontWeight="semibold">
                                  {t("orders.detail.betterSupplier")}
                                </Text>
                                <Text as="p" variant="bodySm">
                                  {alt.title.slice(0, 70)} <PlatformBadge platform={alt.platform as never} />
                                </Text>
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {t("orders.detail.landedEach")} {formatMoney(alt.landedCost, alt.currency)}
                                  {alt.savings ? ` · ${t("orders.detail.saves")} ${formatMoney(alt.savings, alt.currency)}${alt.savingsPercent !== null ? ` (${alt.savingsPercent}%)` : ""}` : ""}
                                  {alt.deliveryDays !== null ? ` · ~${alt.deliveryDays} ${t("common.days")}` : ""}
                                  {` · ${t("orders.detail.covers")} ${alt.coverage}`}
                                </Text>
                                <InlineStack gap="200">
                                  <Link to={`/app/products/${li.productId}#suppliers`}>{t("orders.detail.compareSuppliers")}</Link>
                                  {alt.url && (
                                    <PolarisLink url={alt.url} target="_blank">
                                      {t("common.viewOnSupplier")}
                                    </PolarisLink>
                                  )}
                                </InlineStack>
                              </BlockStack>
                            </Box>
                          )}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {li.managed && !li.isFulfilled && (
                          <Button size="slim" loading={busy} onClick={() => submit({ intent: "ignore-line", lineItemId: li.id, ignored: String(!li.isCanceled) })}>
                            {li.isCanceled ? t("orders.detail.include") : t("orders.detail.ignore")}
                          </Button>
                        )}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("orders.detail.supplierOrders")} count={order.purchaseOrders.length} />
                {order.purchaseOrders.length === 0 && (
                  <EmptyScreen
                    compact
                    heading={t("orders.detail.noSupplierOrder")}
                    body={t("orders.detail.noSupplierOrderBody")}
                    action={canPlace ? { content: t("orders.detail.action.sendToSupplier"), onAction: () => setConfirmSend(true) } : undefined}
                  />
                )}
                {order.purchaseOrders.map((po) => (
                  <Box key={po.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center" wrap>
                        <InlineStack gap="200" blockAlign="center">
                          <PlatformBadge platform={po.platform} />
                          <StatusBadge status={po.status} />
                          <Text as="span" fontWeight="semibold">
                            {po.externalOrderId ?? t("orders.notPlaced")}
                          </Text>
                          {po.account && (
                            <Text as="span" tone="subdued" variant="bodySm">
                              {t("orders.detail.via")} {po.account}
                            </Text>
                          )}
                        </InlineStack>
                        <InlineStack gap="100" wrap>
                          {po.paymentUrl && ["PLACED", "AWAITING_PAYMENT"].includes(po.status) && (
                            <Button size="slim" url={po.paymentUrl} external variant="primary">
                              {t("action.pay")}
                            </Button>
                          )}
                          {po.externalOrderId && (
                            <Button size="slim" loading={busy} onClick={() => submit({ intent: "sync-po", purchaseOrderId: po.id })}>
                              {t("orders.detail.checkStatus")}
                            </Button>
                          )}
                          {!po.externalOrderId && (
                            <Button size="slim" onClick={() => { setManualId(""); setLinkPo(po.id); }}>
                              {t("orders.detail.linkSupplierOrder")}
                            </Button>
                          )}
                          <Button size="slim" onClick={() => { setTracking({ number: "", carrier: "", url: "" }); setTrackingPo(po.id); }}>
                            {t("orders.detail.addTracking")}
                          </Button>
                          {(po.status === "FAILED" || po.status === "CANCELED") && (
                            <Button size="slim" loading={busy} onClick={() => submit({ intent: "retry-po", purchaseOrderId: po.id })}>
                              {t("action.retry")}
                            </Button>
                          )}
                          {["PLACED", "AWAITING_PAYMENT", "PAID"].includes(po.status) && (
                            <Button size="slim" tone="critical" onClick={() => setCancelPo(po.id)}>
                              {t("action.cancel")}
                            </Button>
                          )}
                        </InlineStack>
                      </InlineStack>
                      {po.errorMessage && (
                        <Banner tone="critical">
                          <p>{po.errorMessage}</p>
                        </Banner>
                      )}
                      <InlineGrid columns={{ xs: 3 }} gap="200">
                        <Stat plain size="medium" label={t("orders.detail.itemsCost")} value={formatMoney(po.itemsCost, po.currency)} />
                        <Stat plain size="medium" label={t("common.shipping")} value={formatMoney(po.shippingCost, po.currency)} hint={po.carrierName ? `${po.carrierName}${po.estimatedDays ? ` · ~${po.estimatedDays} ${t("orders.detail.days")}` : ""}` : undefined} />
                        <Stat plain size="medium" label={t("common.total")} value={formatMoney(po.totalCost, po.currency)} hint={po.placedAt ? `${t("orders.detail.placedAt")} ${formatDate(po.placedAt)}` : undefined} />
                      </InlineGrid>
                      {po.items.length > 0 && (
                        <BlockStack gap="050">
                          {po.items.map((i) => (
                            <InlineStack key={i.id} gap="200" align="space-between" blockAlign="center" wrap={false}>
                              <Text as="span" variant="bodySm">
                                {i.quantity} × {i.title.slice(0, 80)}
                                <Text as="span" tone="subdued" variant="bodySm">
                                  {` · SKU ${i.externalSkuId}`}
                                </Text>
                              </Text>
                              <Text as="span" variant="bodySm" numeric>
                                {formatMoney(i.unitCost, po.currency)}
                              </Text>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      )}
                      <Divider />
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingSm">
                          {t("orders.detail.tracking")}
                        </Text>
                        {po.trackings.length === 0 && (
                          <Text as="p" tone="subdued" variant="bodySm">
                            {t("orders.detail.noTracking")}
                          </Text>
                        )}
                        {po.trackings.map((tr) => (
                          <InlineStack key={tr.id} gap="200" blockAlign="center" wrap>
                            {tr.url ? (
                              <PolarisLink url={tr.url} target="_blank">
                                {tr.number}
                              </PolarisLink>
                            ) : (
                              <Text as="span">{tr.number}</Text>
                            )}
                            {tr.carrier && (
                              <Text as="span" tone="subdued" variant="bodySm">
                                {tr.carrier}
                              </Text>
                            )}
                            {tr.status && <Badge>{tr.status}</Badge>}
                            <Badge tone={tr.synced ? "success" : "attention"}>{tr.synced ? t("orders.detail.syncedToShopify") : t("orders.detail.notSynced")}</Badge>
                            {tr.syncError && (
                              <Text as="span" tone="critical" variant="bodySm">
                                {tr.syncError}
                              </Text>
                            )}
                          </InlineStack>
                        ))}
                      </BlockStack>
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("orders.detail.customer")} />
                <BlockStack gap="050">
                  <Text as="p" fontWeight="semibold">
                    {order.customerName ?? t("orders.detail.noCustomer")}
                  </Text>
                  {order.customerEmail && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      {order.customerEmail}
                    </Text>
                  )}
                  <Text as="p" tone="subdued" variant="bodySm">
                    {order.address.phone ?? order.phone ?? t("orders.detail.noPhone")}
                  </Text>
                </BlockStack>
                <Divider />
                <Text as="h3" variant="headingSm">
                  {t("orders.detail.shippingAddress")}
                </Text>
                <BlockStack gap="050">
                  <Text as="p">{addressName}</Text>
                  {order.address.company && <Text as="p">{order.address.company}</Text>}
                  <Text as="p">{order.address.address1}</Text>
                  {order.address.address2 && <Text as="p">{order.address.address2}</Text>}
                  <Text as="p">{[order.address.city, order.address.province ?? order.address.provinceCode, order.address.zip].filter(Boolean).join(", ")}</Text>
                  <Text as="p">{order.address.country ?? order.address.countryCode}</Text>
                  {order.address.taxNumber && (
                    <Text as="p">
                      {t("orders.detail.taxId")}: {order.address.taxNumber}
                    </Text>
                  )}
                </BlockStack>
                <InlineStack>
                  <Button size="slim" onClick={() => setEditing(true)}>
                    {t("orders.detail.editAddress")}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("orders.detail.costs")} />
                <InlineGrid columns={{ xs: 2 }} gap="300">
                  <Stat plain size="medium" label={t("orders.detail.orderTotal")} value={formatMoney(order.total, currency)} />
                  <Stat plain size="medium" label={t("orders.detail.customerPaidShipping")} value={formatMoney(order.shipping, currency)} />
                  <Stat plain size="medium" label={t("orders.detail.supplierCost")} value={priced ? formatMoney(supplierTotal, currency) : "—"} hint={priced ? `${formatMoney(order.supplierCost, currency)} + ${formatMoney(order.supplierShipping, currency)}` : t("orders.detail.costsUnknown")} tone={priced ? "default" : "subdued"} />
                  <Stat
                    plain
                    size="medium"
                    label={t("orders.detail.estProfit")}
                    value={priced ? formatMoney(profit, currency) : "—"}
                    hint={priced ? t("orders.detail.profitMargin", { percent: margin }) : t("orders.detail.costsUnknown")}
                    tone={!priced ? "subdued" : profit >= 0 ? "success" : "critical"}
                  />
                </InlineGrid>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <SectionHeader title={t("orders.detail.orderInfo")} />
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {t("orders.detail.payment")}
                  </Text>
                  <Badge>{order.financialStatus ?? t("orders.detail.unknown")}</Badge>
                </InlineStack>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {t("orders.detail.fulfilment")}
                  </Text>
                  <Badge>{order.fulfillmentStatus ?? t("orders.detail.unfulfilled")}</Badge>
                </InlineStack>
                {order.riskLevel && (
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span" variant="bodySm" tone="subdued">
                      {t("orders.detail.risk")}
                    </Text>
                    <Badge tone={order.riskLevel === "HIGH" ? "critical" : undefined}>{order.riskLevel}</Badge>
                  </InlineStack>
                )}
                {order.tags.length > 0 && (
                  <InlineStack gap="100" wrap>
                    {order.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                  </InlineStack>
                )}
                {order.note && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    {t("orders.detail.note")}: {order.note}
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeader title={t("orders.detail.timeline")} count={activity.length} />
                {activity.length === 0 && <EmptyScreen compact heading={t("orders.detail.noActivity")} body={t("orders.detail.activityEmptyBody")} />}
                {activity.map((a, idx) => (
                  <BlockStack key={a.id} gap="200">
                    {idx > 0 && <Divider />}
                    <BlockStack gap="025">
                      <Text as="p" variant="bodySm" tone={a.level === "error" ? "critical" : undefined}>
                        {a.message}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {formatDate(a.at)} · {a.actor}
                      </Text>
                    </BlockStack>
                  </BlockStack>
                ))}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <Modal
        open={confirmSend}
        onClose={() => setConfirmSend(false)}
        title={t("orders.detail.confirmSend.title", { name: order.name })}
        primaryAction={{
          content: force && errors.length ? t("orders.detail.placeAnyway") : t("orders.detail.confirmSend.confirm"),
          loading: busy,
          onAction: () => {
            setConfirmSend(false);
            submit({ intent: "place", force: String(force) });
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setConfirmSend(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">{force && errors.length ? t("orders.detail.confirmSend.forceBody") : t("orders.detail.confirmSend.body")}</Text>
            <InlineGrid columns={{ xs: 2 }} gap="200">
              <Stat plain size="medium" label={t("orders.detail.supplierCost")} value={priced ? formatMoney(supplierTotal, currency) : "—"} />
              <Stat plain size="medium" label={t("orders.detail.estProfit")} value={priced ? formatMoney(profit, currency) : "—"} tone={!priced ? "subdued" : profit >= 0 ? "success" : "critical"} />
            </InlineGrid>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title={t("orders.detail.address.modalTitle")}
        primaryAction={{
          content: t("orders.address.save"),
          loading: busy,
          onAction: () => {
            setEditing(false);
            submit({ intent: "save-address", ...address, pushToShopify: String(pushToShopify) });
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setEditing(false) }]}
      >
        <Modal.Section>
          <FormLayout>
            <FormLayout.Group>
              <TextField label={t("orders.address.firstName")} value={address.firstName} onChange={(v) => setAddress({ ...address, firstName: v })} autoComplete="off" />
              <TextField label={t("orders.address.lastName")} value={address.lastName} onChange={(v) => setAddress({ ...address, lastName: v })} autoComplete="off" />
            </FormLayout.Group>
            <TextField label={t("orders.address.company")} value={address.company} onChange={(v) => setAddress({ ...address, company: v })} autoComplete="off" />
            <TextField label={t("orders.address.address1")} value={address.address1} onChange={(v) => setAddress({ ...address, address1: v })} autoComplete="off" maxLength={128} showCharacterCount />
            <TextField label={t("orders.address.address2")} value={address.address2} onChange={(v) => setAddress({ ...address, address2: v })} autoComplete="off" />
            <FormLayout.Group>
              <TextField label={t("orders.address.city")} value={address.city} onChange={(v) => setAddress({ ...address, city: v })} autoComplete="off" />
              <TextField label={t("orders.address.province")} value={address.province} onChange={(v) => setAddress({ ...address, province: v })} autoComplete="off" />
            </FormLayout.Group>
            <FormLayout.Group>
              <TextField label={t("orders.address.zip")} value={address.zip} onChange={(v) => setAddress({ ...address, zip: v })} autoComplete="off" />
              <TextField label={t("orders.address.countryCode")} value={address.countryCode} onChange={(v) => setAddress({ ...address, countryCode: v.toUpperCase() })} autoComplete="off" />
            </FormLayout.Group>
            <TextField label={t("orders.address.phone")} value={address.phone} onChange={(v) => setAddress({ ...address, phone: v })} autoComplete="off" />
            <TextField label={t("orders.address.taxNumber")} value={address.taxNumber} onChange={(v) => setAddress({ ...address, taxNumber: v })} autoComplete="off" />
            <Checkbox label={t("orders.address.pushToShopify")} checked={pushToShopify} onChange={setPushToShopify} />
          </FormLayout>
        </Modal.Section>
      </Modal>

      <Modal
        open={linkPo !== null}
        onClose={() => setLinkPo(null)}
        title={t("orders.detail.linkSupplierOrder")}
        primaryAction={{
          content: t("orders.detail.link"),
          disabled: !manualId.trim(),
          loading: busy,
          onAction: () => {
            if (linkPo) submit({ intent: "manual-po", purchaseOrderId: linkPo, externalOrderId: manualId.trim() });
            setLinkPo(null);
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setLinkPo(null) }]}
      >
        <Modal.Section>
          <FormLayout>
            <Text as="p" tone="subdued">
              {t("orders.detail.linkSupplierOrderBody")}
            </Text>
            <TextField label={t("orders.detail.supplierOrderId")} value={manualId} onChange={setManualId} autoComplete="off" helpText={t("orders.detail.manualIdLabel")} />
          </FormLayout>
        </Modal.Section>
      </Modal>

      <Modal
        open={trackingPo !== null}
        onClose={() => setTrackingPo(null)}
        title={t("orders.detail.addTrackingNumber")}
        primaryAction={{
          content: t("orders.detail.add"),
          disabled: !tracking.number.trim(),
          loading: busy,
          onAction: () => {
            if (trackingPo) submit({ intent: "add-tracking", purchaseOrderId: trackingPo, number: tracking.number.trim(), carrier: tracking.carrier.trim(), url: tracking.url.trim() });
            setTrackingPo(null);
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setTrackingPo(null) }]}
      >
        <Modal.Section>
          <FormLayout>
            <TextField label={t("orders.detail.trackingNumber")} value={tracking.number} onChange={(v) => setTracking({ ...tracking, number: v })} autoComplete="off" />
            <TextField label={t("orders.detail.carrier")} value={tracking.carrier} onChange={(v) => setTracking({ ...tracking, carrier: v })} autoComplete="off" />
            <TextField label={t("orders.detail.trackingUrl")} value={tracking.url} onChange={(v) => setTracking({ ...tracking, url: v })} autoComplete="off" type="url" />
          </FormLayout>
        </Modal.Section>
      </Modal>

      <Modal
        open={cancelPo !== null}
        onClose={() => setCancelPo(null)}
        title={t("orders.detail.cancelPo.title")}
        primaryAction={{
          content: t("orders.detail.cancelPo.confirm"),
          destructive: true,
          loading: busy,
          onAction: () => {
            if (cancelPo) submit({ intent: "cancel-po", purchaseOrderId: cancelPo });
            setCancelPo(null);
          },
        }}
        secondaryActions={[{ content: t("orders.detail.cancelPo.keep"), onAction: () => setCancelPo(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t("orders.detail.cancelPo.body")}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
