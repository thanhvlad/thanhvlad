import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { requireShop } from "~/lib/auth.server";
import { env } from "~/lib/env.server";
import { countUnread } from "~/services/notifications.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const unread = await countUnread(shop.id);

  return {
    apiKey: env().SHOPIFY_API_KEY,
    shopDomain: shop.domain,
    unread,
  };
};

export default function App() {
  const { apiKey, unread } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Home
        </Link>
        <Link to="/app/search">Find products</Link>
        <Link to="/app/import">Import list</Link>
        <Link to="/app/products">My products</Link>
        <Link to="/app/orders">Orders</Link>
        <Link to="/app/tracking">Tracking</Link>
        <Link to="/app/suppliers">Suppliers</Link>
        <Link to="/app/pricing">Pricing rules</Link>
        <Link to="/app/shipping">Shipping</Link>
        <Link to="/app/inventory">Auto updates</Link>
        <Link to="/app/reports">Reports</Link>
        <Link to="/app/notifications">
          {unread > 0 ? `Notifications (${unread})` : "Notifications"}
        </Link>
        <Link to="/app/logs">Activity</Link>
        <Link to="/app/settings">Settings</Link>
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
