import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import prisma from "~/db.server";
import { errorMessage } from "~/lib/errors";
import { bootJobs } from "~/services/jobs/index.server";
import { addToImportList } from "~/services/import.server";
import { withSettings } from "~/services/shop.server";
import { detectPlatform } from "~/services/suppliers/index.server";

/**
 * Public endpoint for the browser extension.
 *
 *   POST /api/extension/capture
 *   Authorization: Bearer <shop api token>
 *   { "url": "https://www.aliexpress.com/item/1005006001.html" }
 *   → { ok: true, importedProductId, title }
 *
 * The token is generated under Settings → Advanced. CORS is open because the
 * extension calls from supplier origins.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  return json({ ok: true, endpoint: "POST /api/extension/capture", auth: "Bearer token from Settings → Advanced" });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  bootJobs();

  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ ok: false, error: "Missing bearer token" }, 401);
  const shopRow = await prisma.shop.findUnique({ where: { apiToken: token } });
  if (!shopRow || !shopRow.isActive) return json({ ok: false, error: "Invalid token" }, 401);
  const shop = withSettings(shopRow);

  let body: { url?: string; urls?: string[]; pricingRuleId?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }
  const refs = [...(body.url ? [body.url] : []), ...(body.urls ?? [])].map((s) => String(s).trim()).filter(Boolean).slice(0, 25);
  if (refs.length === 0) return json({ ok: false, error: "Provide url or urls" }, 400);

  const results: Array<{ url: string; ok: boolean; importedProductId?: string; title?: string; platform?: string; error?: string }> = [];
  for (const url of refs) {
    const detected = detectPlatform(url);
    if (!detected) {
      results.push({ url, ok: false, error: "Unrecognised product link" });
      continue;
    }
    try {
      const product = await addToImportList(shop, url, { pricingRuleId: body.pricingRuleId ?? null, actor: "extension" });
      results.push({ url, ok: true, importedProductId: product.id, title: product.title, platform: detected.platform });
    } catch (error) {
      results.push({ url, ok: false, error: errorMessage(error) });
    }
  }
  const first = results[0];
  return json({ ok: results.some((r) => r.ok), ...(refs.length === 1 ? first : {}), results, importListUrl: `https://${shop.domain}/admin/apps/${process.env.SHOPIFY_API_KEY}/app/import` });
};
