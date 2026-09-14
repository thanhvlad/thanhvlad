import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { LanguageDivider, PublicPage, Section } from "~/components/PublicPage";
import prisma from "~/db.server";
import { env } from "~/lib/env.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { connectSupplierAccount, verifyOAuthState } from "~/services/supplier-accounts.server";

/**
 * OAuth return URL for supplier platforms (AliExpress): /suppliers/callback/:platform.
 *
 * It deliberately lives OUTSIDE the /app layout. This was
 * app.suppliers.callback.$platform, and the supplier's return is a top-level
 * redirect carrying no Shopify session, shop or host. Every route under /app
 * also runs the layout loader, whose `authenticate.admin` answered that request
 * by redirecting to /auth/login — and Remix lets the parent's redirect win. So
 * the token was saved, and the merchant was then shown a form asking for their
 * myshopify.com domain (App Store requirement 2.3.1 forbids exactly that) and
 * never told the connection worked. The failure branches went to a relative
 * /app/suppliers, which ended on the same form.
 *
 * Here the signed `state` alone identifies the shop, and every exit is either an
 * absolute URL into that shop's admin or a static page with no input on it. A
 * state whose signature does not verify cannot be trusted to name a shop, so it
 * never picks one: the merchant is sent to their Shopify admin to start again
 * rather than into somebody else's store. A state the app did sign but that has
 * expired does name its shop reliably, so that merchant goes back to Suppliers in
 * their own admin with an explanation; nothing is exchanged or stored for it.
 */

export const meta: MetaFunction = () => [{ title: "Supplier connection · DropshipHub" }];

type Failure = "invalid-state" | "shop-not-found";

function adminSuppliersUrl(shopDomain: string, query: Record<string, string>): string {
  return `https://${shopDomain}/admin/apps/${env().SHOPIFY_API_KEY}/app/suppliers?${new URLSearchParams(query).toString()}`;
}

function failurePage(reason: Failure) {
  return json({ reason }, { status: 400, headers: { "Cache-Control": "no-store" } });
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const check = verifyOAuthState(url.searchParams.get("state") ?? "");

  if (check.status === "invalid") {
    logger.warn("Supplier OAuth callback with a state that does not verify", { platform: params.platform });
    return failurePage("invalid-state");
  }

  const parsed = check.payload;
  const shop = await prisma.shop.findUnique({ where: { id: parsed.shopId } });
  if (!shop) return failurePage("shop-not-found");

  if (check.status === "expired") {
    logger.info("Supplier OAuth callback with an expired state", { platform: parsed.platform, shop: shop.domain });
    return redirect(
      adminSuppliersUrl(shop.domain, { error: "The supplier connection took too long and expired, so nothing was saved. Start it again from Suppliers." }),
    );
  }

  // The platform comes from the signed state. The path segment is only checked
  // against it: taken on its own, a crafted return URL could file the code under
  // a platform the merchant never started connecting.
  const routePlatform = (params.platform ?? "").toUpperCase();
  if (routePlatform && routePlatform !== parsed.platform) {
    logger.warn("Supplier OAuth callback platform does not match its state", { routePlatform, statePlatform: parsed.platform });
    return redirect(adminSuppliersUrl(shop.domain, { error: "The supplier connection could not be verified. Start it again from Suppliers." }));
  }

  if (!code) {
    // The merchant declined on the supplier's page, or the supplier returned an error.
    const supplierError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    return redirect(
      adminSuppliersUrl(shop.domain, {
        error: supplierError ? `The supplier did not authorize the connection: ${supplierError.slice(0, 200)}` : "The supplier did not authorize the connection.",
      }),
    );
  }

  try {
    await connectSupplierAccount({ shopId: shop.id, platform: parsed.platform, code, shareAcrossStores: true, oauthNonce: parsed.nonce || undefined });
  } catch (error) {
    logger.error("Supplier OAuth callback failed", { platform: parsed.platform, error });
    // The message travels in the admin URL; keep it to a sentence, not a dump of the supplier's response.
    return redirect(adminSuppliersUrl(shop.domain, { error: errorMessage(error).slice(0, 300) }));
  }
  return redirect(adminSuppliersUrl(shop.domain, { connected: "1" }));
};

/** Shown only when the return cannot be tied to a store. It has no input on it. */
export default function SupplierCallbackFailed() {
  const { reason } = useLoaderData<typeof loader>();
  const unverified = reason === "invalid-state";
  return (
    <PublicPage title="The supplier connection did not complete" subtitle="Tiếng Việt ở phía dưới.">
      <Section heading="What happened">
        <p>
          {unverified
            ? "This connection link could not be verified, so nothing was saved."
            : "The store this connection was started from is no longer installed, so nothing was saved."}{" "}
          Open DropshipHub from your Shopify admin and start the connection again from Suppliers.
        </p>
        <p>
          <a href="https://admin.shopify.com">Go to your Shopify admin</a>
        </p>
      </Section>

      <LanguageDivider label="Tiếng Việt" />

      <Section heading="Chuyện gì đã xảy ra">
        <p>
          {unverified
            ? "Liên kết kết nối này không xác minh được, nên chưa có gì được lưu."
            : "Cửa hàng bắt đầu kết nối này không còn cài ứng dụng, nên chưa có gì được lưu."}{" "}
          Hãy mở DropshipHub từ trang quản trị Shopify và bắt đầu kết nối lại trong mục Nhà cung cấp.
        </p>
        <p>
          <a href="https://admin.shopify.com">Mở trang quản trị Shopify</a>
        </p>
      </Section>
    </PublicPage>
  );
}
