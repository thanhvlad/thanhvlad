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

  /** Optional: enables AI-assisted variant mapping and supplier picking. */
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MAPPING_MODEL: z.string().default("claude-opus-5"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  EXCHANGE_RATE_API_URL: z.string().default("https://open.er-api.com/v6/latest"),
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
