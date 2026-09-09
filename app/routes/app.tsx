import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { Banner, Box } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { requireShop } from "~/lib/auth.server";
import { env } from "~/lib/env.server";
import { mergeShopSettings } from "~/domain/settings/shop-settings";
import { countUnread } from "~/services/notifications.server";
import { countUnpaid } from "~/services/payments.server";
import { updateShopSettings } from "~/services/shop.server";
import { makeT, type Locale } from "~/lib/i18n";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, role } = await requireShop(request);
  const [unread, unpaid] = await Promise.all([countUnread(shop.id), countUnpaid(shop.id)]);

  // Shopify passes the admin's language as `locale` when it opens the app. A
  // merchant running a Vietnamese admin gets a Vietnamese app from the first
  // screen, and can still pin a language under Settings.
  let locale: Locale = shop.parsedSettings.ui.locale;
  const adminLocale = new URL(request.url).searchParams.get("locale");
  if (!shop.parsedSettings.ui.localeChosen && adminLocale) {
    const detected: Locale = /^vi/i.test(adminLocale) ? "vi" : "en";
    if (detected !== locale) {
      locale = detected;
      await updateShopSettings(shop.id, mergeShopSettings(shop.settings, { ui: { locale } }));
    }
  }

  return {
    apiKey: env().SHOPIFY_API_KEY,
    shopDomain: shop.domain,
    locale,
    role,
    unread,
    unpaid,
  };
};

export default function App() {
  const { apiKey, unread, unpaid, locale, role } = useLoaderData<typeof loader>();
  const t = makeT(locale);

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          {t("nav.home")}
        </Link>
        <Link to="/app/search">{t("nav.search")}</Link>
        <Link to="/app/import">{t("nav.import")}</Link>
        <Link to="/app/products">{t("nav.products")}</Link>
        <Link to="/app/orders">{t("nav.orders")}</Link>
        <Link to="/app/payments">{unpaid > 0 ? `${t("nav.payments")} (${unpaid})` : t("nav.payments")}</Link>
        <Link to="/app/tracking">{t("nav.tracking")}</Link>
        <Link to="/app/suppliers">{t("nav.suppliers")}</Link>
        <Link to="/app/pricing">{t("nav.pricing")}</Link>
        <Link to="/app/shipping">{t("nav.shipping")}</Link>
        <Link to="/app/inventory">{t("nav.inventory")}</Link>
        <Link to="/app/reports">{t("nav.reports")}</Link>
        <Link to="/app/notifications">
          {unread > 0 ? `${t("nav.notifications")} (${unread})` : t("nav.notifications")}
        </Link>
        <Link to="/app/logs">{t("nav.logs")}</Link>
        <Link to="/app/settings">{t("nav.settings")}</Link>
      </NavMenu>
      {role === "READ_ONLY" && (
        <Box padding="400" paddingBlockEnd="0">
          <Banner tone="info" title={t("access.readOnly.title")}>
            <p>{t("access.readOnly.body")}</p>
          </Banner>
        </Box>
      )}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
