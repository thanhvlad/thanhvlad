import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useNavigation, useRouteError, useRouteLoaderData, type ShouldRevalidateFunction } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu, type useAppBridge } from "@shopify/app-bridge-react";
import { AppProvider as PolarisAppProvider, Banner, Box } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { ErrorScreen } from "~/components/ErrorScreen";
import { isShopifyAuthResponse } from "~/components/route-error";
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

type LayoutData = Awaited<ReturnType<typeof loader>>;

/**
 * Screens whose actions can change what this layout shows: the unread and
 * unpaid counts in the navigation, the locale, and the staff role behind the
 * read-only banner. Orders are here because placing a purchase order adds to
 * the unpaid count.
 */
const LAYOUT_AFFECTING_PATHS = ["/app/notifications", "/app/payments", "/app/orders", "/app/settings"];

/**
 * Whether the layout loader runs again.
 *
 * Remix re-runs every loader on the page after any action, so each fetcher
 * submission anywhere in the app (saving a mapping, pushing a product, marking
 * a row) paid for two count queries whose answers could not have changed. The
 * layout now reloads only after actions on the screens listed above, and not
 * when a screen merely changes its own search parameters (a tab, a filter, a
 * page). Notifications created later by background jobs appear on the next
 * full load or the next action on one of those screens, as they already did.
 */
export function layoutShouldRevalidate({
  formMethod,
  formAction,
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: Pick<Parameters<ShouldRevalidateFunction>[0], "formMethod" | "formAction" | "currentUrl" | "nextUrl" | "defaultShouldRevalidate">): boolean {
  if (!defaultShouldRevalidate) return false;
  if (formMethod && formMethod.toUpperCase() !== "GET") {
    const target = new URL(formAction ?? nextUrl.pathname, nextUrl).pathname;
    return LAYOUT_AFFECTING_PATHS.some((path) => target === path || target.startsWith(`${path}/`));
  }
  if (currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) return false;
  return true;
}

export const shouldRevalidate: ShouldRevalidateFunction = (args) => layoutShouldRevalidate(args);

export default function App() {
  const data = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={data.apiKey}>
      <AppNavigation data={data} />
      <NavigationLoading />
      {data.role === "READ_ONLY" && <ReadOnlyBanner locale={data.locale} />}
      <Outlet />
    </AppProvider>
  );
}

function AppNavigation({ data }: { data: Pick<LayoutData, "locale" | "unread" | "unpaid"> }) {
  const t = makeT(data.locale);
  return (
    <NavMenu>
      <Link to="/app" rel="home">
        {t("nav.home")}
      </Link>
      <Link to="/app/search">{t("nav.search")}</Link>
      <Link to="/app/import">{t("nav.import")}</Link>
      <Link to="/app/products">{t("nav.products")}</Link>
      <Link to="/app/orders">{t("nav.orders")}</Link>
      <Link to="/app/payments">{data.unpaid > 0 ? `${t("nav.payments")} (${data.unpaid})` : t("nav.payments")}</Link>
      <Link to="/app/tracking">{t("nav.tracking")}</Link>
      <Link to="/app/suppliers">{t("nav.suppliers")}</Link>
      <Link to="/app/pricing">{t("nav.pricing")}</Link>
      <Link to="/app/shipping">{t("nav.shipping")}</Link>
      <Link to="/app/inventory">{t("nav.inventory")}</Link>
      <Link to="/app/reports">{t("nav.reports")}</Link>
      <Link to="/app/notifications">{data.unread > 0 ? `${t("nav.notifications")} (${data.unread})` : t("nav.notifications")}</Link>
      <Link to="/app/logs">{t("nav.logs")}</Link>
      <Link to="/app/settings">{t("nav.settings")}</Link>
    </NavMenu>
  );
}

function ReadOnlyBanner({ locale }: { locale: Locale }) {
  const t = makeT(locale);
  return (
    <Box padding="400" paddingBlockEnd="0">
      <Banner tone="info" title={t("access.readOnly.title")}>
        <p>{t("access.readOnly.body")}</p>
      </Banner>
    </Box>
  );
}

/**
 * The admin's own loading bar while a page change is in flight.
 *
 * Every link in the navigation waits on `authenticate.admin` plus several
 * queries before anything on screen changes, and nothing said the click had
 * been heard, so merchants clicked again. App Bridge draws the bar in the admin
 * header, which is where a merchant already looks for it.
 *
 * The global is read inside the effect rather than through `useAppBridge()`,
 * which throws during render when the script has not attached yet: a missing
 * progress bar must never be the reason the whole app shows an error.
 */
function NavigationLoading() {
  const busy = useNavigation().state !== "idle";
  useEffect(() => {
    const shopify = (window as unknown as { shopify?: ReturnType<typeof useAppBridge> }).shopify;
    try {
      shopify?.loading(busy);
    } catch {
      // Older App Bridge builds without the loading API: nothing to show.
    }
  }, [busy]);
  return null;
}

/**
 * Errors from this layout's loader or from any page under it.
 *
 * Shopify's own auth responses still go through `boundary.error`, which renders
 * the App Bridge bounce page that finishes signing the merchant in. Everything
 * else used to go there too, and came out as unstyled text in place of the whole
 * app. It now renders the Polaris error screen — inside the app frame with its
 * navigation when the layout itself loaded, so the merchant can simply click
 * somewhere else.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const data = useRouteLoaderData<typeof loader>("routes/app");

  if (isShopifyAuthResponse(error)) return boundary.error(error);

  if (data) {
    return (
      <AppProvider isEmbeddedApp apiKey={data.apiKey}>
        <AppNavigation data={data} />
        <ErrorScreen error={error} />
      </AppProvider>
    );
  }
  // The layout's own loader failed, so there is no API key or locale to build
  // the app frame from. Polaris alone still gives a readable page.
  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <ErrorScreen error={error} />
    </PolarisAppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
