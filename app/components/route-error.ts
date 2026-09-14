import { isRouteErrorResponse } from "@remix-run/react";

/**
 * What an error boundary has caught, reduced to what the error screen needs.
 *
 * Kept free of React and Polaris so the decision — hand the error to Shopify's
 * boundary, or explain it to the merchant, and with which words — is testable
 * on its own.
 */

export type RouteErrorKind = "notFound" | "forbidden" | "unexpected";

export interface RouteErrorSummary {
  kind: RouteErrorKind;
  status: number | null;
  /**
   * A short server message worth showing under the translated heading — the
   * 403 from a role check says which role the person has. Only 4xx text is
   * shown: a 5xx body or a thrown Error can carry a stack or a database message.
   */
  detail: string | null;
}

/**
 * Responses the Shopify library throws on purpose and needs rendered its way.
 *
 * `authenticate.admin` throws a small HTML page carrying the App Bridge script
 * (the session-token bounce and the exit-iframe redirect) and a 401 with a
 * reauthorize header for fetch requests. `boundary.error` renders those so the
 * admin can finish signing the merchant in; replacing them with an error screen
 * would strand the merchant on "Something went wrong" instead of logging them in.
 */
export function isShopifyAuthResponse(error: unknown): boolean {
  if (!isRouteErrorResponse(error)) return false;
  if (error.status === 401) return true;
  return typeof error.data === "string" && /data-api-key=/.test(error.data);
}

const MAX_DETAIL = 300;

export function summarizeRouteError(error: unknown): RouteErrorSummary {
  if (isRouteErrorResponse(error)) {
    const status = error.status;
    const text = typeof error.data === "string" ? error.data.trim() : "";
    const detail = status >= 400 && status < 500 && text && text.length <= MAX_DETAIL && !/[<>]/.test(text) ? text : null;
    if (status === 404) return { kind: "notFound", status, detail: null };
    if (status === 403) return { kind: "forbidden", status, detail };
    return { kind: "unexpected", status, detail };
  }
  return { kind: "unexpected", status: null, detail: null };
}
