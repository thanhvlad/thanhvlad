import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Link } from "@remix-run/react";
import { APP_LISTING_URL, OPEN_IN_ADMIN_URL } from "~/components/PublicPage";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Installs and admin launches arrive with ?shop=; send those straight in.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

/**
 * The app's public URL, which reviewers and search engines open directly.
 *
 * It used to render a "Shop domain" form posting to /auth/login. App Store
 * requirement 2.3.1 forbids asking for a myshopify.com domain anywhere in
 * installation or configuration: installs start from Shopify. So this page only
 * describes the app and points at the listing.
 *
 * The copy says what production does today, and nothing more. It used to
 * promise search and import from AliExpress through its API, "hundreds of
 * orders in one click", and supplier price and stock changes flowing into
 * Shopify — none of which a reviewer could see working.
 */
export default function Landing() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>DropshipHub</h1>
        <p className={styles.text}>
          Bring AliExpress products into your Shopify store with the DropshipHub Chrome extension, edit them before they go live, and keep every
          supplier order next to the Shopify order it belongs to.
        </p>
        <p className={styles.actions}>
          <a className={styles.button} href={APP_LISTING_URL}>
            View on the Shopify App Store
          </a>
          <a href={OPEN_IN_ADMIN_URL}>Already installed? Open it in your Shopify admin</a>
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Import from the product page</strong>. Open a product on AliExpress and press Add to import list in the extension; the title,
            images, variants, prices and description come from that page.
          </li>
          <li>
            <strong>Edit before you publish</strong>. Change titles, images, variants and pricing on the import list before a product reaches your
            store.
          </li>
          <li>
            <strong>Pricing rules</strong>. Turn the supplier cost into your selling price the same way for every product.
          </li>
          <li>
            <strong>Orders with the extension</strong>. Paid Shopify orders wait in the app; you place each one on AliExpress with the extension and
            pay for it there, and the app keeps the supplier order with its Shopify order.
          </li>
        </ul>
        <p className={styles.footer}>
          <Link to="/support">Support</Link> · <Link to="/privacy">Privacy</Link> · <Link to="/terms">Terms</Link>
        </p>
      </div>
    </div>
  );
}
