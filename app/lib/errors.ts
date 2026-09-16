/** Errors that carry a stable code so the UI can localise and the retry logic
 *  can decide whether another attempt is worthwhile. */
export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class SupplierError extends AppError {
  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(code, message, options);
    this.name = "SupplierError";
  }
}

export class MappingError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("MAPPING_INCOMPLETE", message, { details });
    this.name = "MappingError";
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof AppError) return error.retryable;
  // Network-level failures are always worth another go.
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|429|5\d\d/i.test(
    message,
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * The failure payload an action returns for `useErrorMessage`.
 *
 * Errors that know their translation key (a plan limit) pass it along; anything
 * else is shown as its message.
 */
export function actionFailure(error: unknown): { ok: false; error: string; errorKey?: string; errorVars?: Record<string, string | number> } {
  const withKey = error as { messageKey?: unknown; messageVars?: unknown };
  if (error instanceof AppError && typeof withKey.messageKey === "string") {
    return {
      ok: false,
      error: error.message,
      errorKey: withKey.messageKey,
      errorVars: (withKey.messageVars as Record<string, string | number> | undefined) ?? {},
    };
  }
  return { ok: false, error: errorMessage(error) };
}
