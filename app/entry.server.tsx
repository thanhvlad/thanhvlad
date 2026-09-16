import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer, isRouteErrorResponse } from "@remix-run/react";
import { createReadableStreamFromReadable, type ActionFunctionArgs, type EntryContext, type LoaderFunctionArgs } from "@remix-run/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { bootJobs } from "./services/jobs/index.server";
import { logger } from "./lib/logger.server";

// Register job handlers (and start the in-process worker when configured)
// as soon as the server module loads.
bootJobs();

export const streamTimeout = 5000;

/**
 * What reaches the error log.
 *
 * Without this export Remix logs every error in full, and the public internet
 * probes any HTTPS host constantly: /.git/config, /wp-login.php, /robots.txt.
 * Each miss became a thirty-line stack trace, so the error log was mostly bots
 * and a real failure would have been buried under them. A route that does not
 * exist is not an error of this app, and neither is a request the client gave
 * up on.
 */
export function handleError(error: unknown, { request }: LoaderFunctionArgs | ActionFunctionArgs) {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error) && (error.status === 404 || error.status === 405)) return;
  const url = new URL(request.url);
  logger.error("Unhandled route error", { method: request.method, path: url.pathname, error });
}

/**
 * How long browsers keep refusing plain http for this host: one day for now.
 *
 * HSTS cannot be withdrawn early; a browser that saw a year keeps enforcing a
 * year. While the domain, its certificate renewal behind Caddy and the install
 * flow are still new, a mistake must be recoverable within a day. Raise it to
 * 31536000 (one year) once the app has run on this domain for a few weeks with
 * certificates renewing on their own and no plain-http endpoint anyone needs,
 * and only then consider includeSubDomains, which pins every subdomain too.
 */
export const HSTS_MAX_AGE_SECONDS = 86_400;

/**
 * Security headers the Shopify helper leaves to us.
 *
 * `addDocumentResponseHeaders` only sets `frame-ancestors` when the request
 * carries a valid `?shop=`, so the landing page, the legal pages and the login
 * form could be framed by any site (clickjacking the login form in particular).
 * Those pages are never meant to render inside the admin, so without a shop they
 * refuse framing outright.
 *
 * Paths under /app and /auth (other than the login form) are left alone even
 * without a shop: they are the embedded app and its OAuth bounce pages, which
 * Shopify loads inside the admin iframe, and a `frame-ancestors 'none'` that
 * slipped onto one of them would blank the app for the merchant.
 *
 * HSTS goes out only in production and only over HTTPS (directly or as reported
 * by the proxy in front), so local http development is never pinned to TLS.
 */
export function addPublicDocumentHeaders(request: Request, headers: Headers) {
  const url = new URL(request.url);
  headers.set("X-Content-Type-Options", "nosniff");

  const embeddedPath = /^\/(app|auth)(\/|$)/.test(url.pathname) && !/^\/auth\/login\/?$/.test(url.pathname);
  if (!headers.has("Content-Security-Policy") && !embeddedPath) {
    headers.set("Content-Security-Policy", "frame-ancestors 'none';");
  }

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const https = url.protocol === "https:" || forwardedProto === "https";
  if (process.env.NODE_ENV === "production" && https) {
    headers.set("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE_SECONDS}`);
  }
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  addPublicDocumentHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer context={remixContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
