/**
 * In-process token bucket.
 *
 * Enough for the public endpoints the browser extension talks to: they are
 * authenticated by a per-shop token and each request fans out to the supplier
 * API, so an unbounded caller burns the merchant's supplier quota and holds
 * request slots open. This is per process, so it is a guard rail rather than a
 * quota — a multi-instance deployment should put a real limiter in front.
 */
interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next token, when the request was refused. */
  retryAfter: number;
  remaining: number;
}

export function rateLimit(
  key: string,
  options: { limit: number; windowMs: number },
): RateLimitResult {
  const now = Date.now();
  const refillPerMs = options.limit / options.windowMs;

  // Cheap periodic sweep so an abandoned key does not live forever.
  if (now - lastSweep > options.windowMs) {
    lastSweep = now;
    for (const [k, b] of buckets) {
      if (now - b.updatedAt > options.windowMs * 2) buckets.delete(k);
    }
  }

  const bucket = buckets.get(key) ?? { tokens: options.limit, updatedAt: now };
  bucket.tokens = Math.min(options.limit, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return { allowed: false, retryAfter: Math.ceil((1 - bucket.tokens) / refillPerMs / 1000), remaining: 0 };
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return { allowed: true, retryAfter: 0, remaining: Math.floor(bucket.tokens) };
}

/** Test hook. */
export function resetRateLimits() {
  buckets.clear();
  lastSweep = 0;
}
