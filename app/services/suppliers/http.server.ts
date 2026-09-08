import { SupplierError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";

export interface HttpOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /**
   * Set on a call that changes state at the supplier (creating an order,
   * cancelling one). A retry of such a call after a timeout can place the order
   * twice, because a lost response says nothing about whether the supplier
   * committed it. Non-idempotent calls are attempted exactly once and their
   * failures are surfaced as retryable so the caller can decide.
   */
  idempotent?: boolean;
}

/**
 * Small fetch wrapper shared by the live adapters: JSON in/out, query string
 * building, timeouts, and retry with backoff on 429/5xx/network errors.
 */
export async function httpJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null) continue;
    target.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { accept: "application/json", ...(options.headers ?? {}) };
  let body: string | undefined;
  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  // A state-changing call is never retried inside the transport.
  const retries = options.idempotent === false ? 0 : (options.retries ?? 2);
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const response = await fetch(target, {
        method: options.method ?? (body ? "POST" : "GET"),
        headers,
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }

      if (response.status === 429 || response.status >= 500) {
        lastError = new SupplierError("SUPPLIER_HTTP", `HTTP ${response.status} from ${target.host}`, {
          retryable: true,
          details: { status: response.status, body: parsed },
        });
        if (attempt <= retries) {
          await sleep(500 * attempt);
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        throw new SupplierError("SUPPLIER_HTTP", `HTTP ${response.status} from ${target.host}`, {
          details: { status: response.status, body: parsed },
        });
      }
      return parsed as T;
    } catch (error) {
      lastError = error;
      if (error instanceof SupplierError && !error.retryable) throw error;
      if (attempt > retries) break;
      logger.warn("Supplier HTTP retry", { url: target.host, attempt, error });
      await sleep(500 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new SupplierError("SUPPLIER_HTTP", "Request failed", { retryable: true });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
