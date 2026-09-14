import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { bootJobs } from "~/services/jobs/index.server";
import { addToImportList } from "~/services/import.server";
import {
  EXTENSION_BODY_LIMITS,
  ExtensionApiError,
  authenticateExtensionRequest,
  readJsonBody,
  spendExtensionBudget,
} from "~/services/fulfillment.server";
import { detectPlatform } from "~/services/suppliers/index.server";
import { CapturedProduct, capturedToDetail } from "~/services/suppliers/captured.server";

/**
 * Public endpoint for the browser extension.
 *
 *   POST /api/extension/capture
 *   Authorization: Bearer <shop api token>
 *   { "url": "https://www.aliexpress.com/item/1005006001.html", "product": { ... } }
 *   → { ok: true, importedProductId, title }
 *
 * The token is generated under Settings → Advanced. CORS is open because the
 * in-page panel calls from supplier origins; that is safe here because auth is
 * a bearer header rather than a cookie, and the response carries no customer
 * data. The order endpoints, which do, send no CORS headers at all.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...headers } });
}

/** Most links one request may carry; each is a supplier lookup or a database write. */
const MAX_REFERENCES = 25;
/** Links per shop per minute. */
const CAPTURE_LIMIT = 30;

/**
 * The body as hostile input. `product` stays `unknown` here and is validated
 * by CapturedProduct below, so its own error names the field that failed.
 */
const CaptureBody = z.object({
  url: z.string().trim().max(2048).optional(),
  urls: z.array(z.string().trim().max(2048)).max(MAX_REFERENCES).optional(),
  pricingRuleId: z.string().trim().max(64).nullish(),
  product: z.unknown().optional(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  return json({ ok: true, endpoint: "POST /api/extension/capture", auth: "Bearer token from Settings → Advanced" });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  bootJobs();

  try {
    const shop = await authenticateExtensionRequest(request, { scope: "capture", limit: CAPTURE_LIMIT });
    const raw = await readJsonBody(request, EXTENSION_BODY_LIMITS.capture);
    const parsed = CaptureBody.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return json({ ok: false, error: `${first.path.join(".") || "body"} ${first.message}` }, 400);
    }
    const body = parsed.data;
    const refs = [...(body.url ? [body.url] : []), ...(body.urls ?? [])].filter(Boolean).slice(0, MAX_REFERENCES);
    if (refs.length === 0) return json({ ok: false, error: "Provide url or urls" }, 400);

    // Each reference is a supplier round trip or an import write, so the
    // budget is spent per link; authentication already paid for the first.
    spendExtensionBudget(shop.id, { scope: "capture", limit: CAPTURE_LIMIT, cost: refs.length - 1 });

    const results: Array<{ url: string; ok: boolean; importedProductId?: string; title?: string; platform?: string; error?: string }> = [];
    for (const url of refs) {
      const detected = detectPlatform(url);
      if (!detected) {
        results.push({ url, ok: false, error: "Unrecognised product link" });
        continue;
      }
      try {
        // A payload read off the supplier's page imports without any supplier API
        // call. It is only honoured for a single url, so one capture cannot be
        // filed against a list of unrelated links.
        let captured;
        if (body.product !== undefined && refs.length === 1) {
          const product = CapturedProduct.safeParse(body.product);
          if (!product.success) {
            const first = product.error.issues[0];
            results.push({ url, ok: false, error: `Captured product rejected: ${first.path.join(".") || "payload"} ${first.message}` });
            continue;
          }
          captured = capturedToDetail(product.data, detected.platform, detected.externalId);
        }
        const product = await addToImportList(shop, url, { pricingRuleId: body.pricingRuleId ?? null, actor: "extension", captured });
        results.push({ url, ok: true, importedProductId: product.id, title: product.title, platform: detected.platform });
      } catch (error) {
        results.push({ url, ok: false, error: errorMessage(error) });
      }
    }
    const first = results[0];
    return json({ ok: results.some((r) => r.ok), ...(refs.length === 1 ? first : {}), results, importListUrl: `https://${shop.domain}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/import` });
  } catch (error) {
    if (error instanceof ExtensionApiError) return json({ ok: false, error: error.message }, error.status, error.headers);
    logger.error("Extension capture failed", { error });
    return json({ ok: false, error: "Something went wrong on the server." }, 500);
  }
};
