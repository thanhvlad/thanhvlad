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

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
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
