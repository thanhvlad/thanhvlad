import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  DeliveryMethod,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import type { BillingConfig, Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { PAID_PLANS, PLANS } from "./domain/billing/plans";
import { env } from "./lib/env.server";
import { logger } from "./lib/logger.server";
import { ensureWebhooks } from "./services/shopify/webhooks.server";
import type { GraphqlClient } from "./services/shopify/graphql.server";
import { offlineBillingCheck, syncSubscription } from "./services/billing.server";
import { markWebhooksChecked, onShopInstalled } from "./services/shop.server";

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
  // Identify the Shopify staff member behind each request. Without this every
  // action was attributed to "merchant", the activity log could not say who
  // did what, and the roles on the Staff page were decoration - there was
  // nobody to apply them to. Token exchange still stores the offline session
  // first, so background jobs and webhooks are unaffected.
  useOnlineTokens: true,
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
    afterAuth: async ({ session }) => {
      const authenticatedAt = new Date();
      // afterAuth is handed the online session of whichever staff member
      // opened the app (useOnlineTokens), and that token carries only their
      // permissions: webhook registration and the store profile ran with it,
      // and a staff member without Orders access left the store with no order
      // webhooks. Everything here uses the store's offline token instead,
      // which token exchange stored just before this hook runs.
      //
      // Install work is best-effort: an uncaught throw here becomes a bodyless
      // 500 inside the merchant's iframe on their very first open.
      let offline: Awaited<ReturnType<typeof shopify.unauthenticated.admin>>;
      try {
        offline = await shopify.unauthenticated.admin(session.shop);
      } catch (error) {
        logger.error("afterAuth could not load the offline session", { shop: session.shop, error });
        return;
      }
      const graphql = offline.admin.graphql as unknown as GraphqlClient;

      let installed: Awaited<ReturnType<typeof onShopInstalled>> | null = null;
      try {
        installed = await onShopInstalled({ session: offline.session, graphql, authenticatedAt });
      } catch (error) {
        logger.error("onShopInstalled failed", { shop: session.shop, error });
      }

      // Not awaited. Neither is needed to draw the first screen, and together
      // they are up to sixteen Admin API calls the merchant used to wait for on
      // every token exchange. Both are idempotent and re-run on the next one.
      void afterAuthBackground(offline.session, graphql, installed);
    },
  },
  ...(config.SHOP_CUSTOM_DOMAIN ? { customShopDomains: [config.SHOP_CUSTOM_DOMAIN] } : {}),
});

/**
 * The slow half of afterAuth.
 *
 * Billing: reconciling here, not only on the Plan page, is what stops a paid
 * plan surviving an uninstall whose webhook was lost, or a reinstall.
 *
 * Webhooks: subscriptions are declared in shopify.app.toml, but that config was
 * never deployed, so each store registers its own (see ensureWebhooks). The
 * check is skipped while a recent one succeeded, and forced after a reinstall.
 */
async function afterAuthBackground(session: Session, graphql: GraphqlClient, installed: Awaited<ReturnType<typeof onShopInstalled>> | null) {
  if (installed) {
    try {
      await syncSubscription(installed.shop, offlineBillingCheck(graphql));
    } catch (error) {
      logger.warn("Billing reconcile after auth failed", { shop: session.shop, error });
    }
  }
  if (installed && !installed.webhooksDue) return;
  try {
    const { failed } = await ensureWebhooks(session, graphql, (options) => shopify.registerWebhooks(options));
    if (failed.length === 0) await markWebhooksChecked(session.shop);
  } catch (error) {
    logger.error("ensureWebhooks failed", { shop: session.shop, error });
  }
}

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
