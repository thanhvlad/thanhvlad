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
import { addManualTracking, cancelPurchaseOrder, markPurchaseOrderManual, placeSupplierOrders, retryPurchaseOrder, syncPendingTracking, syncPurchaseOrder } from "~/services/fulfillment.server";
import { evaluateAndStoreOrder, getOrderDetail, refreshOrderFromShopify, setLineItemIgnored, updateOrderAddress } from "~/services/orders.server";
import { listActivity } from "~/services/activity.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const order = await getOrderDetail(shop.id, params.id!);
  if (!order) throw new Response("Not found", { status: 404 });
  const activity = await listActivity(shop.id, { entity: "Order", entityId: order.id, limit: 20 });
  return {
    shopDomain: shop.domain,
    currency: shop.currency,
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
        return outcome.ok ? { ok: true, message: `Supplier order(s) placed: ${outcome.purchaseOrderIds.length}.` } : { ok: false, error: outcome.error, issues: outcome.issues };
      }
      case "re-evaluate":
        await evaluateAndStoreOrder(shop, id);
        return { ok: true, message: "Order re-checked." };
      case "refresh": {
        const order = await getOrderDetail(shop.id, id);
        if (order) await refreshOrderFromShopify(shop, graphql, order.shopifyOrderId);
        return { ok: true, message: "Refreshed from Shopify." };
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
        return { ok: true, message: "Address saved." };
      }
      case "ignore-line":
        await setLineItemIgnored(shop, id, get("lineItemId"), get("ignored") === "true");
        return { ok: true, message: "Line item updated." };
      case "sync-po": {
        const result = await syncPurchaseOrder(shop, get("purchaseOrderId"));
        return { ok: true, message: `Supplier says: ${result.status}${result.newTracking ? ` · ${result.newTracking} new tracking` : ""}.` };
      }
      case "retry-po": {
        const outcome = await retryPurchaseOrder(shop, get("purchaseOrderId"), actor);
        return outcome.ok ? { ok: true, message: "Retried." } : { ok: false, error: outcome.error };
      }
      case "cancel-po": {
        const result = await cancelPurchaseOrder(shop, get("purchaseOrderId"), get("reason") || undefined, actor);
        return { ok: true, message: result.upstream ? "Canceled at the supplier." : "Canceled locally; cancel manually at the supplier if needed." };
      }
      case "manual-po":
        await markPurchaseOrderManual(shop, get("purchaseOrderId"), get("externalOrderId"), actor);
        return { ok: true, message: "Supplier order linked." };
      case "add-tracking":
        await addManualTracking(shop, get("purchaseOrderId"), { number: get("number"), carrierName: get("carrier") || null, url: get("url") || null }, actor);
        return { ok: true, message: "Tracking added." };
      case "sync-tracking": {
        const result = await syncPendingTracking(shop, get("purchaseOrderId") || undefined, graphql);
        return { ok: true, message: `${result.synced} tracking number(s) synced${result.failed ? `, ${result.failed} failed` : ""}.` };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function OrderDetailPage() {
  const { order, activity, currency, shopDomain } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string; issues?: string[] } | undefined;
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState<Record<string, string>>({
    firstName: order.address.firstName ?? "", lastName: order.address.lastName ?? "", company: order.address.company ?? "", address1: order.address.address1 ?? "", address2: order.address.address2 ?? "",
    city: order.address.city ?? "", province: order.address.province ?? "", provinceCode: order.address.provinceCode ?? "", zip: order.address.zip ?? "", countryCode: order.address.countryCode ?? "", phone: order.address.phone ?? order.phone ?? "", taxNumber: order.address.taxNumber ?? "",
  });
  const [pushToShopify, setPushToShopify] = useState(false);
  const [manual, setManual] = useState<Record<string, string>>({});
  const [tracking, setTracking] = useState<Record<string, { number: string; carrier: string }>>({});

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
      primaryAction={{ content: order.stage === "PENDING" && errors.length ? "Place anyway (force)" : "Place supplier order", disabled: !canPlace, loading: busy, onAction: () => submit({ intent: "place", force: String(order.stage === "PENDING") }) }}
      secondaryActions={[
        { content: "Open in Shopify", url: adminUrl(shopDomain, `/orders/${legacyId(order.shopifyOrderId)}`), external: true },
        { content: "Refresh from Shopify", onAction: () => submit({ intent: "refresh" }) },
        { content: "Re-check", onAction: () => submit({ intent: "re-evaluate" }) },
      ]}
    >
      <Layout>
        <Layout.Section>
          {result?.message && (
            <Banner tone="success">
              <p>{result.message}</p>
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
            <Banner tone="critical" title="This order cannot be placed yet">
              <List>
                {errors.map((i, idx) => (
                  <List.Item key={idx}>{i.message}</List.Item>
                ))}
              </List>
            </Banner>
          )}
          {warnings.length > 0 && (
            <Banner tone="warning" title="Warnings">
              <List>
                {warnings.map((i, idx) => (
                  <List.Item key={idx}>{i.message}</List.Item>
                ))}
              </List>
            </Banner>
          )}
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Items
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
                        {li.isFulfilled && <Badge tone="success">Fulfilled</Badge>}
                        {li.isCanceled && <Badge>Ignored</Badge>}
                        {!li.managed && <Badge tone="attention">Not managed</Badge>}
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        {li.sku ? `SKU ${li.sku} · ` : ""}
                        {formatMoney(li.price, currency)} each
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
                            {li.resolution.failure ? FAILURE_LABELS[li.resolution.failure] : "Unresolved"}: {li.resolution.reason}
                            {li.productId ? (
                              <>
                                {" "}
                                <Button variant="plain" url={`/app/products/${li.productId}`}>
                                  Fix mapping
                                </Button>
                              </>
                            ) : null}
                          </Text>
                        )
                      )}
                      <InlineStack gap="200">
                        {li.managed && !li.isFulfilled && (
                          <Button size="micro" onClick={() => submit({ intent: "ignore-line", lineItemId: li.id, ignored: String(!li.isCanceled) })}>
                            {li.isCanceled ? "Include" : "Ignore"}
                          </Button>
                        )}
                      </InlineStack>
                    </BlockStack>
                  </InlineStack>
                </Box>
              ))}
              <Divider />
              <InlineGrid columns={{ xs: 2, md: 4 }} gap="200">
                <Stat label="Order total" value={formatMoney(order.total, currency)} />
                <Stat label="Customer paid shipping" value={formatMoney(order.shipping, currency)} />
                <Stat label="Supplier cost" value={formatMoney(order.supplierCost, currency)} />
                <Stat label="Est. profit" value={formatMoney(Number(order.total) - Number(order.supplierCost) - Number(order.supplierShipping), currency)} />
              </InlineGrid>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Supplier orders
                </Text>
                <Button size="slim" onClick={() => submit({ intent: "sync-tracking" })}>
                  Sync tracking to Shopify
                </Button>
              </InlineStack>
              {order.purchaseOrders.length === 0 && (
                <Text as="p" tone="subdued">
                  No supplier order yet.
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
                          {po.externalOrderId ?? "not placed"}
                        </Text>
                        {po.account && (
                          <Text as="span" tone="subdued" variant="bodySm">
                            via {po.account}
                          </Text>
                        )}
                      </InlineStack>
                      <InlineStack gap="100">
                        {po.paymentUrl && ["PLACED", "AWAITING_PAYMENT"].includes(po.status) && (
                          <Button size="slim" url={po.paymentUrl} external variant="primary">
                            Pay at supplier
                          </Button>
                        )}
                        {po.externalOrderId && <Button size="slim" onClick={() => submit({ intent: "sync-po", purchaseOrderId: po.id })}>Check status</Button>}
                        {(po.status === "FAILED" || po.status === "CANCELED") && <Button size="slim" onClick={() => submit({ intent: "retry-po", purchaseOrderId: po.id })}>Retry</Button>}
                        {["PLACED", "AWAITING_PAYMENT", "PAID"].includes(po.status) && (
                          <Button size="slim" tone="critical" onClick={() => submit({ intent: "cancel-po", purchaseOrderId: po.id })}>
                            Cancel
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
                      Items {formatMoney(po.itemsCost, po.currency)} · Shipping {formatMoney(po.shippingCost, po.currency)} · Total {formatMoney(po.totalCost, po.currency)}
                      {po.carrierName ? ` · ${po.carrierName}` : ""}
                      {po.estimatedDays ? ` (~${po.estimatedDays} days)` : ""}
                      {po.placedAt ? ` · placed ${formatDate(po.placedAt)}` : ""}
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
                        {po.trackings.map((t) => (
                          <InlineStack key={t.id} gap="200" blockAlign="center">
                            <Badge tone={t.synced ? "success" : "attention"}>{t.synced ? "Synced to Shopify" : "Not synced"}</Badge>
                            {t.url ? (
                              <Button variant="plain" url={t.url} external>
                                {t.number}
                              </Button>
                            ) : (
                              <Text as="span">{t.number}</Text>
                            )}
                            {t.carrier && (
                              <Text as="span" tone="subdued" variant="bodySm">
                                {t.carrier}
                              </Text>
                            )}
                            {t.status && <Badge>{t.status}</Badge>}
                            {t.syncError && (
                              <Text as="span" tone="critical" variant="bodySm">
                                {t.syncError}
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
                            <TextField label="Placed manually? Enter the supplier order id" value={manual[po.id] ?? ""} onChange={(v) => setManual({ ...manual, [po.id]: v })} autoComplete="off" />
                          </div>
                          <Button onClick={() => submit({ intent: "manual-po", purchaseOrderId: po.id, externalOrderId: manual[po.id] ?? "" })} disabled={!manual[po.id]}>
                            Link
                          </Button>
                        </InlineStack>
                      )}
                      <InlineStack gap="200" blockAlign="end">
                        <TextField label="Add tracking number" value={tracking[po.id]?.number ?? ""} onChange={(v) => setTracking({ ...tracking, [po.id]: { number: v, carrier: tracking[po.id]?.carrier ?? "" } })} autoComplete="off" />
                        <TextField label="Carrier" value={tracking[po.id]?.carrier ?? ""} onChange={(v) => setTracking({ ...tracking, [po.id]: { number: tracking[po.id]?.number ?? "", carrier: v } })} autoComplete="off" />
                        <Button onClick={() => submit({ intent: "add-tracking", purchaseOrderId: po.id, number: tracking[po.id]?.number ?? "", carrier: tracking[po.id]?.carrier ?? "" })} disabled={!tracking[po.id]?.number}>
                          Add
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
                    Shipping address
                  </Text>
                  <Button size="slim" onClick={() => setEditing(!editing)}>
                    {editing ? "Close" : "Edit"}
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
                      {order.address.phone ?? order.phone ?? "No phone"}
                    </Text>
                    {order.address.taxNumber && <Text as="p">Tax ID: {order.address.taxNumber}</Text>}
                    {order.customerEmail && (
                      <Text as="p" tone="subdued" variant="bodySm">
                        {order.customerEmail}
                      </Text>
                    )}
                  </BlockStack>
                ) : (
                  <FormLayout>
                    <FormLayout.Group>
                      <TextField label="First name" value={address.firstName} onChange={(v) => setAddress({ ...address, firstName: v })} autoComplete="off" />
                      <TextField label="Last name" value={address.lastName} onChange={(v) => setAddress({ ...address, lastName: v })} autoComplete="off" />
                    </FormLayout.Group>
                    <TextField label="Company / tax ID holder" value={address.company} onChange={(v) => setAddress({ ...address, company: v })} autoComplete="off" />
                    <TextField label="Address 1" value={address.address1} onChange={(v) => setAddress({ ...address, address1: v })} autoComplete="off" maxLength={128} showCharacterCount />
                    <TextField label="Address 2" value={address.address2} onChange={(v) => setAddress({ ...address, address2: v })} autoComplete="off" />
                    <FormLayout.Group>
                      <TextField label="City" value={address.city} onChange={(v) => setAddress({ ...address, city: v })} autoComplete="off" />
                      <TextField label="Province" value={address.province} onChange={(v) => setAddress({ ...address, province: v })} autoComplete="off" />
                    </FormLayout.Group>
                    <FormLayout.Group>
                      <TextField label="ZIP" value={address.zip} onChange={(v) => setAddress({ ...address, zip: v })} autoComplete="off" />
                      <TextField label="Country code" value={address.countryCode} onChange={(v) => setAddress({ ...address, countryCode: v.toUpperCase() })} autoComplete="off" />
                    </FormLayout.Group>
                    <TextField label="Phone" value={address.phone} onChange={(v) => setAddress({ ...address, phone: v })} autoComplete="off" />
                    <TextField label="Tax / customs ID (CPF, RUT, PCCC…)" value={address.taxNumber} onChange={(v) => setAddress({ ...address, taxNumber: v })} autoComplete="off" />
                    <Checkbox label="Also update the address in Shopify" checked={pushToShopify} onChange={setPushToShopify} />
                    <Button variant="primary" onClick={() => submit({ intent: "save-address", ...address, pushToShopify: String(pushToShopify) })} loading={busy}>
                      Save address
                    </Button>
                  </FormLayout>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Details
                </Text>
                <Text as="p" variant="bodySm">
                  Payment: <Badge>{order.financialStatus ?? "unknown"}</Badge>
                </Text>
                <Text as="p" variant="bodySm">
                  Fulfilment: <Badge>{order.fulfillmentStatus ?? "unfulfilled"}</Badge>
                </Text>
                {order.riskLevel && (
                  <Text as="p" variant="bodySm">
                    Risk: <Badge tone={order.riskLevel === "HIGH" ? "critical" : undefined}>{order.riskLevel}</Badge>
                  </Text>
                )}
                {order.tags.length > 0 && (
                  <InlineStack gap="100" wrap>
                    {order.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </InlineStack>
                )}
                {order.note && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Note: {order.note}
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Timeline
                </Text>
                {activity.length === 0 && (
                  <Text as="p" tone="subdued">
                    No activity yet.
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
