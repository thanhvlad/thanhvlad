import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { requireShop } from "~/lib/auth.server";
import { env } from "~/lib/env.server";
import { countUnread } from "~/services/notifications.server";
import { countUnpaid } from "~/services/payments.server";
import { makeT } from "~/lib/i18n";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const [unread, unpaid] = await Promise.all([countUnread(shop.id), countUnpaid(shop.id)]);

  return {
    apiKey: env().SHOPIFY_API_KEY,
    shopDomain: shop.domain,
    locale: shop.parsedSettings.ui.locale,
    unread,
    unpaid,
  };
};

export default function App() {
  const { apiKey, unread, unpaid, locale } = useLoaderData<typeof loader>();
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
