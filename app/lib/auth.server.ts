import { authenticate } from "~/shopify.server";
import { getOrCreateShop, type ShopWithSettings } from "~/services/shop.server";

/**
 * Authenticate an embedded-admin request and load the matching Shop row.
 * Every `/app/*` loader and action starts here.
 */
export async function requireShop(request: Request) {
  const { admin, session } = await authenticate.admin(request);
  const shop: ShopWithSettings = await getOrCreateShop(session.shop);
  return { admin, session, shop };
}

export type RequireShopResult = Awaited<ReturnType<typeof requireShop>>;
