import type { LinksFunction, MetaFunction } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";

/**
 * Defaults for anything that does not set its own. The embedded admin pages
 * are framed by Shopify and never show these; the public pages — landing,
 * privacy, terms, support — are what a merchant, a reviewer or a search engine
 * sees, and an untitled tab showing a raw URL is what they judge first.
 */
export const meta: MetaFunction = () => [
  { title: "DropshipHub — AliExpress dropshipping for Shopify" },
  { name: "description", content: "Import products from AliExpress and other suppliers, map variants, place supplier orders in bulk and sync tracking back to Shopify." },
];

export const links: LinksFunction = () => [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
