import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Link } from "@remix-run/react";
import { OPEN_IN_ADMIN_URL } from "~/components/PublicPage";
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
 * The app's public URL, which reviewers and search engines open directly, and
 * where /auth/login sends anyone who reaches the app without a shop.
 *
 * It used to render a "Shop domain" form posting to /auth/login. App Store
 * requirement 2.3.1 forbids asking for a myshopify.com domain anywhere in
 * installation or configuration: installs start from Shopify. So this page only
 * describes the app and points into the Shopify admin. It does not link to an
 * App Store listing, because the app is not listed yet and that link is a
 * Shopify 404.
 *
 * The copy says what production does today, and nothing more. It used to
 * promise search and import from AliExpress through its API, "hundreds of
 * orders in one click", and supplier price and stock changes flowing into
 * Shopify, none of which a reviewer could see working. It then said orders are
 * placed "with the extension", which reads as the extension placing them; the
 * merchant places and pays for every AliExpress order on AliExpress, and the
 * ordering sentence below is the one the support page, the terms and the app's
 * own screens use.
 */
export default function Landing() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>DropshipHub</h1>
        <p className={styles.text}>
          Bring AliExpress products into your Shopify store with the DropshipHub Chrome extension, edit them before they go live, and keep every
          AliExpress order and its tracking next to the Shopify order it belongs to.
        </p>
        <p className={styles.actions}>
          <a className={styles.button} href={OPEN_IN_ADMIN_URL}>
            Open in your Shopify admin
          </a>
          <span className={styles.note}>DropshipHub runs inside the Shopify admin of the stores it is installed on.</span>
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
            <strong>Ordering on AliExpress</strong>. The Chrome extension lists the orders waiting to be placed and opens each product on AliExpress.
            You place and pay for the order there, then record the AliExpress order number in the extension; tracking you add there is sent to
            Shopify.
          </li>
        </ul>
        <p className={styles.footer}>
          <Link to="/support">Support</Link> · <Link to="/privacy">Privacy</Link> · <Link to="/terms">Terms</Link>
        </p>
      </div>
    </div>
  );
}
