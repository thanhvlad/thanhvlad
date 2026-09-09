import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { LUMORA_CONTRACT_VERSION, LUMORA_WRITING_CONTRACT } from "~/domain/copy/lumora-contract";
import { env } from "~/lib/env.server";
import { errorMessage } from "~/lib/errors";
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
  /** False when the endpoint would not carry the images and they went unseen. */
  imagesAssessed: boolean;
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

/**
 * The output contract, stated in the prompt as well as in `output_config`.
 *
 * `output_config` is the right mechanism and the real API honours it. But this
 * app can be pointed at an Anthropic-compatible gateway through
 * ANTHROPIC_BASE_URL, and a gateway that drops the field answers in prose -
 * which reached the merchant as "Failed to parse structured output". Stating the
 * same contract in words costs a few hundred tokens and makes the call work
 * against either kind of endpoint.
 */
const JSON_INSTRUCTION = [
  "OUTPUT FORMAT - answer with a single JSON object and nothing else. No prose",
  "before it, no code fence around it. These keys, exactly:",
  "",
  '  "title"           string  - the finished title, following the HEAD - TAIL rule.',
  '  "descriptionHtml" string  - the complete body HTML.',
  '  "tags"            array of 8 to 12 lowercase strings.',
  '  "heroImageIndex"  number  - 0-based index of the image that should lead.',
  '  "imageVerdicts"   array   - one {"index": number, "usable": boolean, "reason": string}',
  "                              per image supplied, in order.",
].join("\n");

function tryParse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Pull the result object out of a response.
 *
 * The strict path is a whole-text JSON.parse, which is what a well-behaved
 * endpoint returns. The salvage paths handle a model or gateway that wrapped the
 * object in a code fence or a sentence: take the fenced block, else the first
 * balanced brace span. Salvaging is worth doing because the alternative is
 * discarding a page that is present and correct, over its packaging.
 */
export function extractResult(text: string): Record<string, unknown> | null {
  const direct = tryParse(text.trim());
  if (direct) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed) return parsed;
  }

  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return tryParse(text.slice(start, i + 1));
    }
  }
  return null;
}

/**
 * True when retrying without the images could plausibly succeed.
 *
 * A 400, 413 or 422 is the endpoint refusing the request as shaped, and the
 * images are by far the largest and least widely supported part of it. 403 is
 * included because at least one gateway answers a request it will not carry
 * with "Your request was blocked" rather than a shape error. Auth failures,
 * rate limits and server faults are left alone - dropping the images would not
 * change any of them.
 */
export function mightBeTheImages(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 400 || status === 403 || status === 413 || status === 422;
}

interface ModelCall {
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  userText: string;
  images: string[];
  model: string;
}

async function callModel(client: Anthropic, call: ModelCall) {
  const response = await client.messages.create({
    model: call.model,
    max_tokens: 16000,
    system: call.system,
    output_config: { format: jsonSchemaOutputFormat(REWRITE_SCHEMA), effort: "high" },
    messages: [
      {
        role: "user",
        content: [
          ...call.images.map((url) => ({ type: "image" as const, source: { type: "url" as const, url } })),
          { type: "text" as const, text: call.userText },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to rewrite this product.");
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
  const parsed = extractResult(text);
  if (!parsed) {
    throw new Error(
      `The endpoint returned no JSON object. It answered: ${text.slice(0, 200).replace(/\s+/g, " ") || "(nothing)"}`,
    );
  }
  return { parsed, usage: response.usage };
}

/** Reject a shape that would otherwise crash on the way out. */
function requireShape(parsed: Record<string, unknown>): void {
  const missing = (["title", "descriptionHtml", "tags", "heroImageIndex"] as const).filter((key) => parsed[key] == null);
  if (missing.length) throw new Error(`The model's answer is missing: ${missing.join(", ")}.`);
  if (!Array.isArray(parsed.tags)) throw new Error("The model returned tags that are not a list.");
}

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
    `IMAGES: ${input.images.length} supplied.`,
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

  // Two cache breakpoints, both stable. The contract never varies, and the
  // worked examples are identical for every product in a batch. Leaving the
  // examples in the user turn meant paying full price for the same ~10k
  // tokens on every single product.
  const system = [
    { type: "text" as const, text: LUMORA_WRITING_CONTRACT, cache_control: { type: "ephemeral" as const } },
    ...(exampleBlock
      ? [{ type: "text" as const, text: exampleBlock, cache_control: { type: "ephemeral" as const } }]
      : []),
  ];

  const withImages = [
    facts,
    ``,
    `The first ${visionImages.length} image(s) are attached above, in order, index 0 first. Judge each one.`,
    ``,
    JSON_INSTRUCTION,
  ].join("\n");

  const withoutImages = [
    facts,
    ``,
    `The images could not be attached on this run. Their urls are below in order.`,
    `Judge only what the url and the supplier data can tell you, and say so in each reason.`,
    ...input.images.slice(0, MAX_VISION_IMAGES).map((u, i) => `  ${i}: ${u}`),
    ``,
    JSON_INSTRUCTION,
  ].join("\n");

  const model = env().AI_MAPPING_MODEL;
  let imagesAssessed = visionImages.length > 0;
  let result;
  try {
    result = await callModel(client, { system, userText: withImages, images: visionImages, model });
  } catch (error) {
    // A page written from the supplier text alone is worth far more to the
    // merchant than a failed job, so an endpoint that will not carry the images
    // costs the image verdicts rather than the whole rewrite. It is recorded,
    // not hidden - the caller turns `imagesAssessed: false` into a warning the
    // merchant can see.
    if (!(visionImages.length > 0 && mightBeTheImages(error))) throw error;
    logger.warn("Retrying the rewrite without images", { error: errorMessage(error) });
    result = await callModel(client, { system, userText: withoutImages, images: [], model });
    imagesAssessed = false;
  }

  const parsed = result.parsed;
  requireShape(parsed);

  const usage = result.usage;
  logger.info("Landing page rewritten", {
    supplierTitle: input.supplierTitle.slice(0, 80),
    imagesAssessed,
    inputTokens: usage?.input_tokens,
    cacheRead: usage?.cache_read_input_tokens,
    outputTokens: usage?.output_tokens,
  });

  const verdicts = Array.isArray(parsed.imageVerdicts) ? (parsed.imageVerdicts as ImageVerdict[]) : [];
  return {
    title: String(parsed.title),
    descriptionHtml: String(parsed.descriptionHtml),
    tags: (parsed.tags as unknown[]).map((t) => String(t)),
    heroImageIndex: Number(parsed.heroImageIndex),
    imageVerdicts: verdicts.filter((v) => v && typeof v === "object" && typeof v.index === "number"),
    imagesAssessed,
    contractVersion: LUMORA_CONTRACT_VERSION,
  };
}
