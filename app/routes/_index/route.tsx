import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>DropshipHub</h1>
        <p className={styles.text}>
          Import products from AliExpress and other suppliers, map variants, place
          hundreds of orders in one click and sync tracking back to Shopify.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" placeholder="my-shop.myshopify.com" />
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Import list</strong>. Edit titles, images, variants and pricing before a
            product ever reaches your store.
          </li>
          <li>
            <strong>Mapping</strong>. Basic, Advanced (per-country ranked suppliers), BOGO and
            Bundle mapping so every order routes to the right SKU.
          </li>
          <li>
            <strong>Bulk orders</strong>. Place supplier orders in bulk, choose shipping
            automatically and sync tracking numbers to Shopify.
          </li>
          <li>
            <strong>Auto updates</strong>. Supplier price and stock changes flow into Shopify
            on your rules.
          </li>
        </ul>
      </div>
    </div>
  );
}
