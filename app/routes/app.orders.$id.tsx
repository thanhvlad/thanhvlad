import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
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
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { PlatformBadge, StatusBadge } from "~/components/StatusBadge";
import { Thumb } from "~/components/Thumb";
import type { ResolveResult } from "~/domain/mapping/types";
import { FAILURE_LABELS } from "~/domain/mapping/resolve";
import type { ShippingAddress } from "~/domain/orders/address";
import type { OrderIssue } from "~/domain/orders/pipeline";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { adminUrl, formatDate, formatMoney, legacyId } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
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

export default function OrderDetailPage() {
  const t = useT();
  const { order, activity, currency, shopDomain, alternatives, approval } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string; issues?: string[] } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState<Record<string, string>>({
    firstName: order.address.firstName ?? "", lastName: order.address.lastName ?? "", company: order.address.company ?? "", address1: order.address.address1 ?? "", address2: order.address.address2 ?? "",
    city: order.address.city ?? "", province: order.address.province ?? "", provinceCode: order.address.provinceCode ?? "", zip: order.address.zip ?? "", countryCode: order.address.countryCode ?? "", phone: order.address.phone ?? order.phone ?? "", taxNumber: order.address.taxNumber ?? "",
  });
  const [pushToShopify, setPushToShopify] = useState(false);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [tracking, setTracking] = useState<Record<string, { number: string; carrier: string }>>({});
  const [declineReason, setDeclineReason] = useState("");

  const errors = order.issues.filter((i) => i.severity === "error");
  const warnings = order.issues.filter((i) => i.severity === "warning");
  const canPlace = order.stage === "AWAITING_ORDER" || order.stage === "PENDING" || order.stage === "FAILED";
  const busy = fetcher.state !== "idle";
  const submit = (payload: Record<string, string>) => fetcher.submit(payload, { method: "post" });

  return (
    <Page
      backAction={{ url: "/app/orders" }}
      title={order.name}
      titleMetadata={<StatusBadge status={order.stage} />}
      subtitle={`${formatDate(order.createdAt)} · ${order.customerName ?? order.customerEmail ?? ""}`}
      primaryAction={{ content: order.stage === "PENDING" && errors.length ? t("orders.detail.placeAnyway") : t("action.placeOrder"), disabled: !canPlace, loading: busy, onAction: () => submit({ intent: "place", force: String(order.stage === "PENDING") }) }}
      secondaryActions={[
        { content: t("orders.detail.openInShopify"), url: adminUrl(shopDomain, `/orders/${legacyId(order.shopifyOrderId)}`), external: true },
        { content: t("orders.detail.refreshFromShopify"), onAction: () => submit({ intent: "refresh" }) },
        { content: t("orders.detail.recheck"), onAction: () => submit({ intent: "re-evaluate" }) },
      ]}
    >
      <Layout>
        <Layout.Section>
          {actionMessage && (
            <Banner tone="success">
              <p>{actionMessage}</p>
            </Banner>
          )}
          {result?.error && (
            <Banner tone="critical" title={result.error}>
              {result.issues?.length ? (
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
        </Layout.Section>

        {approval && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="attention">{t("orders.detail.awaitingApproval")}</Badge>
                  <Text as="h2" variant="headingMd">
                    {t("orders.detail.approvalTitle")}
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
                      <Stat label={t("orders.detail.supplierItems")} value={formatMoney(approval.quote.itemsCost, approval.quote.currency)} />
                      <Stat label={t("orders.detail.supplierShipping")} value={formatMoney(approval.quote.shippingCost, approval.quote.currency)} />
                      <Stat label={t("orders.detail.youWillPay")} value={formatMoney(approval.quote.totalCost, approval.quote.currency)} />
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
                  <Button
                    variant="primary"
                    loading={fetcher.state !== "idle"}
                    onClick={() => submit({ intent: "approve-fulfillment", requestId: approval.id })}
                  >
                    {t("orders.detail.approveAndSend")}
                  </Button>
                  <Button
                    tone="critical"
                    onClick={() => submit({ intent: "decline-fulfillment", requestId: approval.id, reason: declineReason })}
                  >
                    {t("orders.detail.decline")}
                  </Button>
                </InlineStack>
                <TextField
                  label={t("orders.detail.declineReason")}
                  labelHidden
                  autoComplete="off"
                  placeholder={t("orders.detail.declineReason")}
                  value={declineReason}
                  onChange={setDeclineReason}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("orders.detail.items")}
              </Text>
              {order.lineItems.map((li) => (
                <Box key={li.id} padding="200" background={li.isCanceled ? "bg-surface-secondary" : undefined} borderRadius="200" borderColor="border" borderWidth="025">
                  <InlineStack gap="300" blockAlign="start" wrap={false}>
                    <Thumb src={li.image} alt={li.title} />
                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="p" fontWeight="semibold">
                          {li.quantity} × {li.title}
                        </Text>
                        {li.variantTitle && <Badge>{li.variantTitle}</Badge>}
                        {li.isFulfilled && <Badge tone="success">{t("stage.FULFILLED")}</Badge>}
                        {li.isCanceled && <Badge>{t("orders.detail.ignored")}</Badge>}
                        {!li.managed && <Badge tone="attention">{t("orders.notManaged")}</Badge>}
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        {li.sku ? `SKU ${li.sku} · ` : ""}
                        {formatMoney(li.price, currency)} {t("orders.detail.each")}
                      </Text>
                      {li.managed && li.resolution && (
                        li.resolution.ok ? (
                          <BlockStack gap="050">
                            {li.resolution.lines.map((l) => (
                              <Text as="p" key={l.mappingRowId} variant="bodySm">
                                → {l.quantity} × {l.title.slice(0, 70)} @ {formatMoney(l.unitCost, l.currency)} <PlatformBadge platform={l.platform} />
                              </Text>
                            ))}
                          </BlockStack>
                        ) : (
                          <Text as="p" tone="critical" variant="bodySm">
                            {li.resolution.failure ? FAILURE_LABELS[li.resolution.failure] : t("orders.detail.unresolved")}: {li.resolution.reason}
                            {li.productId ? (
                              <>
                                {" "}
                                <Button variant="plain" url={`/app/products/${li.productId}`}>
                                  {t("orders.detail.fixMapping")}
                                </Button>
                              </>
                            ) : null}
                          </Text>
                        )
                      )}
                      {li.productId && alternatives[li.productId] && (
                        <Box padding="200" background="bg-surface-info" borderRadius="200">
                          <BlockStack gap="050">
                            <Text as="p" variant="bodySm" fontWeight="semibold">
                              {t("orders.detail.betterSupplier")}
                            </Text>
                            <Text as="p" variant="bodySm">
                              {alternatives[li.productId].title.slice(0, 70)}{" "}
                              <PlatformBadge platform={alternatives[li.productId].platform as never} />
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {t("orders.detail.landedEach")} {formatMoney(alternatives[li.productId].landedCost, alternatives[li.productId].currency)}
                              {alternatives[li.productId].savings
                                ? ` · ${t("orders.detail.saves")} ${formatMoney(alternatives[li.productId].savings!, alternatives[li.productId].currency)}${
                                    alternatives[li.productId].savingsPercent !== null ? ` (${alternatives[li.productId].savingsPercent}%)` : ""
                                  }`
                                : ""}
                              {alternatives[li.productId].deliveryDays !== null ? ` · ~${alternatives[li.productId].deliveryDays} ${t("common.days")}` : ""}
                              {` · ${t("orders.detail.covers")} ${alternatives[li.productId].coverage}`}
                            </Text>
                            <InlineStack gap="200">
                              <Button variant="plain" url={`/app/products/${li.productId}#suppliers`}>
                                {t("orders.detail.compareSuppliers")}
                              </Button>
                              {alternatives[li.productId].url && (
                                <Button variant="plain" url={alternatives[li.productId].url!} target="_blank">
                                  {t("common.viewOnSupplier")}
                                </Button>
                              )}
                            </InlineStack>
                          </BlockStack>
                        </Box>
                      )}
                      <InlineStack gap="200">
                        {li.managed && !li.isFulfilled && (
                          <Button size="micro" onClick={() => submit({ intent: "ignore-line", lineItemId: li.id, ignored: String(!li.isCanceled) })}>
                            {li.isCanceled ? t("orders.detail.include") : t("orders.detail.ignore")}
                          </Button>
                        )}
                      </InlineStack>
                    </BlockStack>
                  </InlineStack>
                </Box>
              ))}
              <Divider />
              <InlineGrid columns={{ xs: 2, md: 4 }} gap="200">
                <Stat label={t("orders.detail.orderTotal")} value={formatMoney(order.total, currency)} />
                <Stat label={t("orders.detail.customerPaidShipping")} value={formatMoney(order.shipping, currency)} />
                <Stat label={t("orders.detail.supplierCost")} value={formatMoney(order.supplierCost, currency)} />
                <Stat label={t("orders.detail.estProfit")} value={formatMoney(Number(order.total) - Number(order.supplierCost) - Number(order.supplierShipping), currency)} />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  {t("orders.detail.supplierOrders")}
                </Text>
                <Button size="slim" onClick={() => submit({ intent: "sync-tracking" })}>
                  {t("orders.detail.syncTracking")}
                </Button>
              </InlineStack>
              {order.purchaseOrders.length === 0 && (
                <Text as="p" tone="subdued">
                  {t("orders.detail.noSupplierOrder")}
                </Text>
              )}
              {order.purchaseOrders.map((po) => (
                <Box key={po.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                  <BlockStack gap="200">
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
                      <InlineStack gap="100">
                        {po.paymentUrl && ["PLACED", "AWAITING_PAYMENT"].includes(po.status) && (
                          <Button size="slim" url={po.paymentUrl} external variant="primary">
                            {t("action.pay")}
                          </Button>
                        )}
                        {po.externalOrderId && <Button size="slim" onClick={() => submit({ intent: "sync-po", purchaseOrderId: po.id })}>{t("orders.detail.checkStatus")}</Button>}
                        {(po.status === "FAILED" || po.status === "CANCELED") && <Button size="slim" onClick={() => submit({ intent: "retry-po", purchaseOrderId: po.id })}>{t("action.retry")}</Button>}
                        {["PLACED", "AWAITING_PAYMENT", "PAID"].includes(po.status) && (
                          <Button size="slim" tone="critical" onClick={() => submit({ intent: "cancel-po", purchaseOrderId: po.id })}>
                            {t("action.cancel")}
                          </Button>
                        )}
                      </InlineStack>
                    </InlineStack>
                    {po.errorMessage && (
                      <Text as="p" tone="critical" variant="bodySm">
                        {po.errorMessage}
                      </Text>
                    )}
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t("orders.detail.itemsCost")} {formatMoney(po.itemsCost, po.currency)} · {t("common.shipping")} {formatMoney(po.shippingCost, po.currency)} · {t("common.total")} {formatMoney(po.totalCost, po.currency)}
                      {po.carrierName ? ` · ${po.carrierName}` : ""}
                      {po.estimatedDays ? ` (~${po.estimatedDays} ${t("orders.detail.days")})` : ""}
                      {po.placedAt ? ` · ${t("orders.detail.placedOn")} ${formatDate(po.placedAt)}` : ""}
                    </Text>
                    <BlockStack gap="050">
                      {po.items.map((i) => (
                        <Text as="p" key={i.id} variant="bodySm">
                          {i.quantity} × {i.title.slice(0, 80)} — {formatMoney(i.unitCost, po.currency)} (SKU {i.externalSkuId})
                        </Text>
                      ))}
                    </BlockStack>
                    {po.trackings.length > 0 && (
                      <BlockStack gap="050">
                        {po.trackings.map((tr) => (
                          <InlineStack key={tr.id} gap="200" blockAlign="center">
                            <Badge tone={tr.synced ? "success" : "attention"}>{tr.synced ? t("orders.detail.syncedToShopify") : t("orders.detail.notSynced")}</Badge>
                            {tr.url ? (
                              <Button variant="plain" url={tr.url} external>
                                {tr.number}
                              </Button>
                            ) : (
                              <Text as="span">{tr.number}</Text>
                            )}
                            {tr.carrier && (
                              <Text as="span" tone="subdued" variant="bodySm">
                                {tr.carrier}
                              </Text>
                            )}
                            {tr.status && <Badge>{tr.status}</Badge>}
                            {tr.syncError && (
                              <Text as="span" tone="critical" variant="bodySm">
                                {tr.syncError}
                              </Text>
                            )}
                          </InlineStack>
                        ))}
                      </BlockStack>
                    )}
                    <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                      {!po.externalOrderId && (
                        <InlineStack gap="200" blockAlign="end">
                          <div style={{ flex: 1 }}>
                            <TextField label={t("orders.detail.manualIdLabel")} value={manual[po.id] ?? ""} onChange={(v) => setManual({ ...manual, [po.id]: v })} autoComplete="off" />
                          </div>
                          <Button onClick={() => submit({ intent: "manual-po", purchaseOrderId: po.id, externalOrderId: manual[po.id] ?? "" })} disabled={!manual[po.id]}>
                            {t("orders.detail.link")}
                          </Button>
                        </InlineStack>
                      )}
                      <InlineStack gap="200" blockAlign="end">
                        <TextField label={t("orders.detail.addTrackingNumber")} value={tracking[po.id]?.number ?? ""} onChange={(v) => setTracking({ ...tracking, [po.id]: { number: v, carrier: tracking[po.id]?.carrier ?? "" } })} autoComplete="off" />
                        <TextField label={t("orders.detail.carrier")} value={tracking[po.id]?.carrier ?? ""} onChange={(v) => setTracking({ ...tracking, [po.id]: { number: tracking[po.id]?.number ?? "", carrier: v } })} autoComplete="off" />
                        <Button onClick={() => submit({ intent: "add-tracking", purchaseOrderId: po.id, number: tracking[po.id]?.number ?? "", carrier: tracking[po.id]?.carrier ?? "" })} disabled={!tracking[po.id]?.number}>
                          {t("orders.detail.add")}
                        </Button>
                      </InlineStack>
                    </InlineGrid>
                  </BlockStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    {t("orders.detail.shippingAddress")}
                  </Text>
                  <Button size="slim" onClick={() => setEditing(!editing)}>
                    {editing ? t("orders.detail.close") : t("orders.detail.edit")}
                  </Button>
                </InlineStack>
                {!editing ? (
                  <BlockStack gap="050">
                    <Text as="p">{order.address.name ?? [order.address.firstName, order.address.lastName].filter(Boolean).join(" ")}</Text>
                    {order.address.company && <Text as="p">{order.address.company}</Text>}
                    <Text as="p">{order.address.address1}</Text>
                    {order.address.address2 && <Text as="p">{order.address.address2}</Text>}
                    <Text as="p">
                      {[order.address.city, order.address.province ?? order.address.provinceCode, order.address.zip].filter(Boolean).join(", ")}
                    </Text>
                    <Text as="p">{order.address.country ?? order.address.countryCode}</Text>
                    <Text as="p" tone="subdued">
                      {order.address.phone ?? order.phone ?? t("orders.detail.noPhone")}
                    </Text>
                    {order.address.taxNumber && (
                      <Text as="p">
                        {t("orders.detail.taxId")}: {order.address.taxNumber}
                      </Text>
                    )}
                    {order.customerEmail && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        {order.customerEmail}
                      </Text>
                    )}
                  </BlockStack>
                ) : (
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
                    <Button variant="primary" onClick={() => submit({ intent: "save-address", ...address, pushToShopify: String(pushToShopify) })} loading={busy}>
                      {t("orders.address.save")}
                    </Button>
                  </FormLayout>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  {t("orders.detail.details")}
                </Text>
                <Text as="p" variant="bodySm">
                  {t("orders.detail.payment")}: <Badge>{order.financialStatus ?? t("orders.detail.unknown")}</Badge>
                </Text>
                <Text as="p" variant="bodySm">
                  {t("orders.detail.fulfilment")}: <Badge>{order.fulfillmentStatus ?? t("orders.detail.unfulfilled")}</Badge>
                </Text>
                {order.riskLevel && (
                  <Text as="p" variant="bodySm">
                    {t("orders.detail.risk")}: <Badge tone={order.riskLevel === "HIGH" ? "critical" : undefined}>{order.riskLevel}</Badge>
                  </Text>
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
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  {t("orders.detail.timeline")}
                </Text>
                {activity.length === 0 && (
                  <Text as="p" tone="subdued">
                    {t("orders.detail.noActivity")}
                  </Text>
                )}
                {activity.map((a) => (
                  <BlockStack key={a.id} gap="025">
                    <Text as="p" variant="bodySm" tone={a.level === "error" ? "critical" : undefined}>
                      {a.message}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {formatDate(a.at)} · {a.actor}
                    </Text>
                  </BlockStack>
                ))}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="050">
      <Text as="p" tone="subdued" variant="bodySm">
        {label}
      </Text>
      <Text as="p" fontWeight="semibold">
        {value}
      </Text>
    </BlockStack>
  );
}
