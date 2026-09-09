import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { logger } from "~/lib/logger.server";

/**
 * Fulfilment-service callback endpoint.
 *
 * Shopify requires a callback URL when registering a fulfilment service and
 * calls its legacy sub-paths (`/fetch_stock`, `/fetch_tracking_numbers`) on some
 * plans. The app manages inventory and tracking through the Admin API instead —
 * inventory is pushed by the auto-update job and tracking by the fulfilment
 * sync — so these answer with an empty, well-formed result rather than an error,
 * which is what stops Shopify disabling the service.
 */
function respond(request: Request) {
  const path = new URL(request.url).pathname;
  logger.debug("Fulfilment service callback", { path, method: request.method });
  if (path.endsWith("/fetch_stock")) return json({});
  if (path.endsWith("/fetch_tracking_numbers")) return json({ message: "Tracking is pushed by the app", tracking_numbers: {} });
  return json({ ok: true });
}

export const loader = ({ request }: LoaderFunctionArgs) => respond(request);
export const action = ({ request }: ActionFunctionArgs) => respond(request);
