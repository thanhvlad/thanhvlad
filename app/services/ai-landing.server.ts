import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { LUMORA_CONTRACT_VERSION, LUMORA_WRITING_CONTRACT } from "~/domain/copy/lumora-contract";
import { env } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";

/**
 * Rewrite an imported supplier product into a finished landing page.
 *
 * This publishes to a live storefront with no human review, which changes what
 * "good enough" means. Two consequences run through the whole file:
 *
 *   - The contract is long on purpose. It is not style advice, it is the
 *     specification, measured off the store's own 80 shipped products. It is
 *     sent as a cacheable system block so its length costs one cache miss per
 *     model version rather than one per product.
 *   - Nothing the model returns is trusted. `checkRewrite` re-derives the rules
 *     that can be checked deterministically, and a page that fails is not
 *     published - it is returned with its reasons so the merchant sees why.
 *
 * With no ANTHROPIC_API_KEY the feature is simply unavailable, matching how
 * ai-mapping.server.ts already behaves.
 */

export interface RewriteInput {
  supplierTitle: string;
  supplierDescriptionHtml: string;
  /** Image urls in supplier order. The model sees them, so it can judge them. */
  images: string[];
  optionNames: string[];
  variants: Array<{ attributes: Array<{ name: string; value: string }>; price: string; stock: number }>;
  currency: string;
  storeName?: string | null;
  /** Two or three of the shop's own finished pages, as worked examples. */
  examples?: Array<{ title: string; descriptionHtml: string }>;
}

export interface ImageVerdict {
  index: number;
  usable: boolean;
  reason: string;
}

export interface RewriteResult {
  title: string;
  descriptionHtml: string;
  tags: string[];
  heroImageIndex: number;
  imageVerdicts: ImageVerdict[];
  contractVersion: string;
}

const REWRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      type: "string",
      description: "The finished product title, following the HEAD — TAIL rule in the contract exactly.",
    },
    descriptionHtml: {
      type: "string",
      description: "The complete body HTML for the product page, following the section skeleton in the contract.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "8 to 12 lowercase tags.",
    },
    heroImageIndex: {
      type: "number",
      description: "0-based index into the supplied images of the one that should lead the page.",
    },
    imageVerdicts: {
      type: "array",
      description: "One entry per supplied image, in order.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          index: { type: "number", description: "0-based index of the image being judged." },
          usable: { type: "boolean", description: "False when it carries supplier text, a watermark, a collage, or is too low quality to sell with." },
          reason: { type: "string", description: "One short sentence a merchant would understand." },
        },
        required: ["index", "usable", "reason"],
      },
    },
  },
  required: ["title", "descriptionHtml", "tags", "heroImageIndex", "imageVerdicts"],
} as const;

export function aiLandingAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Vision needs a reachable http(s) url, and a long tail of images costs tokens
 * for no judgement gain. Eight is past the point where a page uses them. */
const MAX_VISION_IMAGES = 8;

export async function rewriteLandingPage(input: RewriteInput): Promise<RewriteResult> {
  if (!aiLandingAvailable()) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const client = new Anthropic();

  const visionImages = input.images.filter((u) => /^https?:\/\//i.test(u)).slice(0, MAX_VISION_IMAGES);

  const facts = [
    `SUPPLIER TITLE: ${input.supplierTitle}`,
    input.storeName ? `SUPPLIER STORE: ${input.storeName}` : "",
    `CURRENCY: ${input.currency}`,
    input.optionNames.length ? `OPTION AXES: ${input.optionNames.join(", ")}` : "OPTION AXES: none",
    ``,
    `VARIANTS (${input.variants.length}):`,
    ...input.variants.slice(0, 40).map((v) => {
      const attrs = v.attributes.map((a) => `${a.name}=${a.value}`).join(" / ") || "(single)";
      return `- ${attrs} | price ${v.price} ${input.currency} | stock ${v.stock}`;
    }),
    ``,
    `IMAGES: ${input.images.length} supplied; the first ${visionImages.length} are attached above in order, index 0 first.`,
    ``,
    `SUPPLIER DESCRIPTION (raw, this is the register you must eliminate):`,
    input.supplierDescriptionHtml.slice(0, 12_000) || "(the supplier published none)",
  ]
    .filter(Boolean)
    .join("\n");

  const examples = (input.examples ?? []).slice(0, 3);
  const exampleBlock = examples.length
    ? [
        ``,
        `WORKED EXAMPLES - finished pages from this same store. Match their structure,`,
        `their markup and their voice. Do not copy their subject matter or their claims.`,
        ...examples.flatMap((e, i) => [``, `--- EXAMPLE ${i + 1} TITLE ---`, e.title, `--- EXAMPLE ${i + 1} BODY ---`, e.descriptionHtml.slice(0, 20_000)]),
      ].join("\n")
    : "";

  const response = await client.messages.parse({
    model: env().AI_MAPPING_MODEL,
    max_tokens: 16000,
    // The contract is stable across every product, so it is the cache prefix.
    // Everything that varies per product sits in the user turn, after it.
    system: [{ type: "text", text: LUMORA_WRITING_CONTRACT, cache_control: { type: "ephemeral" } }],
    output_config: { format: jsonSchemaOutputFormat(REWRITE_SCHEMA), effort: "high" },
    messages: [
      {
        role: "user",
        content: [
          ...visionImages.map((url) => ({ type: "image" as const, source: { type: "url" as const, url } })),
          { type: "text" as const, text: `${facts}${exampleBlock}` },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to rewrite this product.");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The model returned no structured result.");

  const usage = response.usage;
  logger.info("Landing page rewritten", {
    supplierTitle: input.supplierTitle.slice(0, 80),
    inputTokens: usage?.input_tokens,
    cacheRead: usage?.cache_read_input_tokens,
    outputTokens: usage?.output_tokens,
  });

  return {
    title: String(parsed.title),
    descriptionHtml: String(parsed.descriptionHtml),
    tags: (parsed.tags as string[]).map((t) => String(t)),
    heroImageIndex: Number(parsed.heroImageIndex),
    imageVerdicts: (parsed.imageVerdicts as ImageVerdict[]) ?? [],
    contractVersion: LUMORA_CONTRACT_VERSION,
  };
}
