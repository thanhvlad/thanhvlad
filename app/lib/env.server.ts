import { z } from "zod";

/**
 * Environment parsing. Everything optional-with-default except the Shopify
 * credentials, so `npm run test` and `prisma generate` work on a bare checkout.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  SHOPIFY_API_KEY: z.string().default(""),
  SHOPIFY_API_SECRET: z.string().default(""),
  SHOPIFY_APP_URL: z.string().default("http://localhost:3000"),
  SCOPES: z.string().default(""),
  SHOP_CUSTOM_DOMAIN: z.string().optional(),

  DATABASE_URL: z.string().default(""),

  REDIS_URL: z.string().optional(),
  QUEUE_PREFIX: z.string().default("dropship-hub"),
  RUN_WORKER_IN_WEB: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  SUPPLIER_DRIVER: z.enum(["mock", "live"]).default("mock"),

  ALIEXPRESS_APP_KEY: z.string().optional(),
  ALIEXPRESS_APP_SECRET: z.string().optional(),
  ALIEXPRESS_REDIRECT_URI: z.string().optional(),
  ALIEXPRESS_API_BASE: z.string().default("https://api-sg.aliexpress.com/sync"),
  ALIEXPRESS_AUTH_BASE: z.string().default("https://api-sg.aliexpress.com/oauth"),
  ALIEXPRESS_TRACKING_ID: z.string().optional(),

  CJ_API_BASE: z.string().default("https://developers.cjdropshipping.com/api2.0/v1"),
  CJ_EMAIL: z.string().optional(),
  CJ_API_KEY: z.string().optional(),

  ENCRYPTION_KEY: z.string().optional(),

  /**
   * Force Shopify Billing into test mode (no real charges). Always on outside
   * production and on development stores; set it on a staging deployment that
   * talks to a live store.
   */
  BILLING_TEST: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  /**
   * Outbound email. Pick a provider explicitly, or leave it unset and the app
   * uses Resend when RESEND_API_KEY is present, else SMTP when SMTP_URL is,
   * else keeps notifications in the in-app feed only.
   */
  EMAIL_PROVIDER: z.enum(["smtp", "resend", "none"]).optional(),
  EMAIL_FROM: z.string().default("DropshipHub <no-reply@example.com>"),
  /** smtp://user:pass@host:587 or smtps://user:pass@host:465 */
  SMTP_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  /** Shown on the public support page and used as the reply-to address. */
  SUPPORT_EMAIL: z.string().optional(),

  /** Optional: enables AI-assisted variant mapping. Supplier ranking is a
   * deterministic weighted score (app/domain/suppliers/score.ts) and does not
   * use this key. */
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MAPPING_MODEL: z.string().default("claude-opus-5"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  EXCHANGE_RATE_API_URL: z.string().default("https://open.er-api.com/v6/latest"),
}).superRefine((values, ctx) => {
  // Every default above exists so a bare checkout can run tests and generate
  // the Prisma client. In production a missing value is a misconfiguration
  // that must stop the boot with a clear message, not surface later as a
  // failed OAuth, a plaintext supplier token or a job that never runs.
  if (values.NODE_ENV !== "production") return;
  const missing = (key: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "required in production" });
  if (!values.SHOPIFY_API_KEY) missing("SHOPIFY_API_KEY");
  if (!values.SHOPIFY_API_SECRET) missing("SHOPIFY_API_SECRET");
  if (!/^https:\/\//.test(values.SHOPIFY_APP_URL)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SHOPIFY_APP_URL"], message: "must be the public https URL of this deployment" });
  }
  if (!values.DATABASE_URL) missing("DATABASE_URL");
  if (!values.ENCRYPTION_KEY) missing("ENCRYPTION_KEY");
  if (values.SUPPLIER_DRIVER === "live" && !(values.ALIEXPRESS_APP_KEY || values.CJ_API_KEY)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SUPPLIER_DRIVER"], message: "live driver needs ALIEXPRESS_APP_KEY/SECRET or CJ_API_KEY" });
  }
});

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(
        `Invalid environment:\n${parsed.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n")}`,
      );
    }
    cached = parsed.data;
  }
  return cached;
}

export const isProduction = () => env().NODE_ENV === "production";
export const isTest = () => env().NODE_ENV === "test";
