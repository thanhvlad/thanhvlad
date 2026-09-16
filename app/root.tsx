import type { ReactNode } from "react";
import type { LinksFunction, MetaFunction } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRevalidator,
  useRouteError,
} from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider as PolarisAppProvider, Banner, BlockStack, Layout as PolarisLayout, Page, Text } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { isShopifyAuthResponse, summarizeRouteError } from "~/components/route-error";
import { translate } from "~/lib/i18n";

/**
 * Defaults for anything that does not set its own. The embedded admin pages
 * are framed by Shopify and never show these; the public pages — landing,
 * privacy, terms, support — are what a merchant, a reviewer or a search engine
 * sees, and an untitled tab showing a raw URL is what they judge first.
 *
 * The description used to promise bulk supplier orders and tracking synced back
 * automatically. Production places no supplier order by itself: the merchant
 * places and pays for each one on AliExpress, and a search snippet is a listing
 * claim like any other.
 */
export const meta: MetaFunction = () => [
  { title: "DropshipHub — AliExpress dropshipping for Shopify" },
  {
    name: "description",
    content:
      "Import AliExpress products into Shopify with the DropshipHub Chrome extension, price and edit them before they go live, and keep each AliExpress order you place, and its tracking, next to its Shopify order.",
  },
];

export const links: LinksFunction = () => [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }];

/**
 * The document shell, shared by the app and the root error boundary.
 *
 * Remix renders `ErrorBoundary` inside this same Layout, so an error page keeps
 * the charset, viewport, fonts and scripts instead of each boundary having to
 * rebuild a whole document by hand.
 */
export function Layout({ children }: { children: ReactNode }) {
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
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * The error page for everything outside /app.
 *
 * The /app layout has its own boundary with the app's navigation. The public
 * routes — the landing page, support, privacy, terms, the login path, the
 * supplier OAuth return, and any URL that matches no route at all — had none,
 * so a mistyped link or a failing loader showed Remix's unstyled "Application
 * Error" page, sometimes with a stack trace. This is the same Polaris banner the
 * app's error screen uses, in both languages because a public page has no
 * merchant setting to pick one from.
 *
 * The wording comes from the app's error-screen strings. Only the title is
 * shown for "not found" and "forbidden": their bodies talk about lists and
 * staff roles inside the app, which mean nothing on a public page. No server
 * text is shown for a 5xx or a thrown Error, since that is where stacks and
 * database messages end up.
 *
 * A response the Shopify library threw on purpose (the App Bridge bounce page,
 * a 401 asking for reauthorization) still goes to the library's own boundary,
 * so a sign-in that reaches this far can finish.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();

  if (isShopifyAuthResponse(error)) return boundary.error(error);

  const summary = summarizeRouteError(error);
  const showBody = summary.kind === "unexpected";

  return (
    <>
      <link rel="stylesheet" href={polarisStyles} />
      <PolarisAppProvider i18n={polarisTranslations}>
        {/* English leads; the Vietnamese title is the one-line subtitle every Page carries. */}
        <Page narrowWidth title={translate("en", `errorScreen.${summary.kind}.title`)} subtitle={translate("vi", `errorScreen.${summary.kind}.title`)}>
          <PolarisLayout>
            <PolarisLayout.Section>
              <Banner
                tone={summary.kind === "unexpected" ? "critical" : "warning"}
                title={summary.status ? translate("en", "errorScreen.status", { status: summary.status }) : undefined}
                action={
                  summary.kind === "unexpected"
                    ? {
                        content: `${translate("en", "errorScreen.retry")} · ${translate("vi", "errorScreen.retry")}`,
                        onAction: () => revalidator.revalidate(),
                        loading: revalidator.state !== "idle",
                      }
                    : undefined
                }
                secondaryAction={{ content: `${translate("en", "errorScreen.home")} · ${translate("vi", "errorScreen.home")}`, url: "/" }}
              >
                <BlockStack gap="200">
                  {showBody && <p>{translate("en", "errorScreen.unexpected.body")}</p>}
                  {showBody && <p lang="vi">{translate("vi", "errorScreen.unexpected.body")}</p>}
                  {summary.detail && (
                    <Text as="p" tone="subdued">
                      {summary.detail}
                    </Text>
                  )}
                </BlockStack>
              </Banner>
            </PolarisLayout.Section>
          </PolarisLayout>
        </Page>
      </PolarisAppProvider>
    </>
  );
}
