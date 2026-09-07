import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import type { SupplierPlatform } from "@prisma/client";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { connectSupplierAccount, parseOAuthState } from "~/services/supplier-accounts.server";

/**
 * OAuth return URL for supplier platforms (e.g. AliExpress). This is a
 * top-level redirect from the supplier, so there is no Shopify session:
 * the signed `state` identifies the shop. After storing the token we send
 * the merchant back into the embedded app.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const parsed = parseOAuthState(state);
  const platform = (params.platform ?? "").toUpperCase() as SupplierPlatform;

  if (!parsed || !code) {
    return redirect(`/app/suppliers?error=${encodeURIComponent("Invalid or expired authorization state.")}`);
  }
  const shop = await prisma.shop.findUnique({ where: { id: parsed.shopId } });
  if (!shop) return redirect(`/app/suppliers?error=${encodeURIComponent("Shop not found.")}`);

  try {
    await connectSupplierAccount({ shopId: shop.id, platform: platform || parsed.platform, code, shareAcrossStores: true });
  } catch (error) {
    logger.error("Supplier OAuth callback failed", { platform, error });
    return redirect(`https://${shop.domain}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/suppliers?error=${encodeURIComponent(errorMessage(error))}`);
  }
  return redirect(`https://${shop.domain}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/suppliers?connected=1`);
};
