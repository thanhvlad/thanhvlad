import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { AppProvider as PolarisAppProvider, Banner, BlockStack, Card, Link, Page, Text } from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { OPEN_IN_ADMIN_URL } from "~/components/PublicPage";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

/**
 * The library's login path. `authenticate.admin` sends any request without a
 * shop or host here, so it is reachable by anyone who opens an /app URL outside
 * the admin.
 *
 * It used to render a "Shop domain" text field. App Store requirement 2.3.1
 * forbids asking for a myshopify.com domain during installation or
 * configuration, so the field is gone. A request that already names a shop (a
 * link from the admin) still goes through `login()`, which is the only thing the
 * library allows on this route; anything else is sent to the app's public page.
 *
 * That used to be the App Store listing, which does not exist while the app is
 * unlisted: the library sends every /app request that has lost its shop or host
 * here, so the owner opening the app URL outside the admin landed on a Shopify
 * 404 that also refuses to be framed. The public page always exists, describes
 * the app and links into the Shopify admin, and its own loader still sends a
 * request carrying ?shop= into /app, so this cannot loop.
 */
const PUBLIC_ENTRY_PATH = "/";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (!url.searchParams.get("shop")) throw redirect(PUBLIC_ENTRY_PATH);
  return { errors: loginErrorMessage(await login(request)) };
};

/** Nothing posts here any more; an old bookmarked form lands on the public page. */
export const action = async () => redirect(PUBLIC_ENTRY_PATH);

export default function Auth() {
  const { errors } = useLoaderData<typeof loader>();

  return (
    <PolarisAppProvider i18n={polarisTranslations}>
      <Page narrowWidth>
        <Card>
          <BlockStack gap="300">
            <Text variant="headingMd" as="h2">
              Open DropshipHub from your Shopify admin
            </Text>
            {errors.shop && (
              <Banner tone="warning">
                <p>That link does not point to a Shopify store, so DropshipHub could not open it.</p>
              </Banner>
            )}
            <Text as="p">
              DropshipHub runs inside the Shopify admin. <Link url={OPEN_IN_ADMIN_URL}>Open your Shopify admin</Link> and choose DropshipHub under
              Apps.
            </Text>
          </BlockStack>
        </Card>
      </Page>
    </PolarisAppProvider>
  );
}
