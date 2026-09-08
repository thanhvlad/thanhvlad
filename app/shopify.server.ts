import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  DeliveryMethod,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import type { BillingConfig } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { PAID_PLANS, PLANS } from "./domain/billing/plans";
import { env } from "./lib/env.server";
import { logger } from "./lib/logger.server";
import { onShopInstalled } from "./services/shop.server";

const config = env();

/**
 * Shopify Billing plans, keyed by the name Shopify shows on its approval page
 * and echoes back as the subscription name. Derived from the plan catalogue so
 * the price a merchant is quoted and the cap they get can never disagree.
 */
const billing: BillingConfig = Object.fromEntries(
  PAID_PLANS.map((id) => [
    PLANS[id].displayName,
    {
      trialDays: PLANS[id].trialDays,
      // Moving between plans replaces the current subscription at once rather
      // than waiting for the period to end, so an upgrade takes effect the
      // moment the merchant approves it.
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [{ amount: PLANS[id].monthlyPrice, currencyCode: "USD", interval: BillingInterval.Every30Days as const }],
    },
  ]),
);

const shopify = shopifyApp({
  apiKey: config.SHOPIFY_API_KEY,
  apiSecretKey: config.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: config.SCOPES?.split(",").map((s) => s.trim()).filter(Boolean),
  appUrl: config.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  webhooks: {
    // Webhook subscriptions are declared in shopify.app.toml and registered by
    // the CLI on deploy; this map only tells the framework how to route them.
    APP_UNINSTALLED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/app" },
    APP_SCOPES_UPDATE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/app" },
    APP_SUBSCRIPTIONS_UPDATE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/app" },
    ORDERS_CREATE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/orders" },
    ORDERS_UPDATED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/orders" },
    ORDERS_CANCELLED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/orders" },
    ORDERS_PAID: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/orders" },
    ORDERS_FULFILLED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/orders" },
    PRODUCTS_UPDATE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/products" },
    PRODUCTS_DELETE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/products" },
    FULFILLMENTS_CREATE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/fulfillments" },
    FULFILLMENTS_UPDATE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/fulfillments" },
    FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_SUBMITTED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/fulfillment-orders" },
    FULFILLMENT_ORDERS_CANCELLATION_REQUEST_SUBMITTED: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/fulfillment-orders" },
    FULFILLMENT_ORDERS_ORDER_ROUTING_COMPLETE: { deliveryMethod: DeliveryMethod.Http, callbackUrl: "/webhooks/fulfillment-orders" },
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Subscriptions are declared in shopify.app.toml and created by the CLI on
      // deploy. registerWebhooks() discovers existing subscriptions with the
      // `webhookSubscriptions` query, which returns only shop-scoped ones, so
      // calling it here cannot see the app-scoped subscriptions and creates a
      // second subscription per topic - every event then arrives twice.
      //
      // Install work is best-effort: an uncaught throw here becomes a bodyless
      // 500 inside the merchant's iframe on their very first open.
      try {
        await onShopInstalled({ session, admin });
      } catch (error) {
        logger.error("onShopInstalled failed", { shop: session.shop, error });
      }
    },
  },
  ...(config.SHOP_CUSTOM_DOMAIN ? { customShopDomains: [config.SHOP_CUSTOM_DOMAIN] } : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;

export type AdminApiContext = Awaited<ReturnType<typeof authenticate.admin>>["admin"];
export type AdminGraphqlClient = AdminApiContext["graphql"];
