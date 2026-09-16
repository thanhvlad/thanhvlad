import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { env } from "~/lib/env.server";
import { errorMessage } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { matchVariants, type MatchAssignment, type MatchCandidate, type MatchTarget } from "~/domain/mapping/match";

/**
 * Variant mapping in two passes.
 *
 * The deterministic matcher (app/domain/mapping/match.ts) resolves the ordinary
 * cases — synonyms, translations, reordered options — with no network call and
 * no cost. Whatever it cannot place is handed to Claude, which is good at the
 * judgement calls a lookup table cannot encode: "Bundle A (2 cups + lid)" for
 * "2-Pack With Lid", or a supplier that names a colour by its marketing name.
 *
 * With no ANTHROPIC_API_KEY configured the AI pass is skipped and the merchant
 * simply confirms the remaining rows by hand, which is the pre-AI behaviour.
 */

export interface AiMappingInput {
  productTitle: string;
  supplierTitle: string;
  optionNames: string[];
  targets: MatchTarget[];
  candidates: MatchCandidate[];
}

export interface MappingSuggestion extends MatchAssignment {
  source: "AUTO" | "AI";
}

export interface SuggestionResult {
  suggestions: MappingSuggestion[];
  aiUsed: boolean;
  aiError: string | null;
  /** Targets still without a candidate after both passes. */
  unresolved: number;
}

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    matches: {
      type: "array",
      description: "One entry per Shopify variant you can confidently match.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          variantId: { type: "string", description: "The Shopify variant id given in the input." },
          skuId: { type: "string", description: "The supplier SKU id given in the input, or an empty string when nothing matches." },
          confidence: { type: "number", description: "0 to 1. Use below 0.6 when unsure; those are discarded." },
          reason: { type: "string", description: "One short sentence a merchant would understand." },
        },
        required: ["variantId", "skuId", "confidence", "reason"],
      },
    },
  },
  required: ["matches"],
} as const;

export function aiMappingAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Run the deterministic pass, then ask Claude about the leftovers.
 * Never throws: an AI failure degrades to the deterministic result.
 */
export async function suggestMapping(input: AiMappingInput, options: { useAi?: boolean; threshold?: number } = {}): Promise<SuggestionResult> {
  const threshold = options.threshold ?? 0.6;
  const deterministic = matchVariants(input.targets, input.candidates, { threshold });

  const suggestions: MappingSuggestion[] = deterministic.assignments
    .filter((a) => a.candidateId)
    .map((a) => ({ ...a, source: "AUTO" as const }));

  const takenCandidates = new Set(suggestions.map((s) => s.candidateId!));
  const unmatched = deterministic.unmatched;
  const wantAi = (options.useAi ?? true) && unmatched.length > 0 && aiMappingAvailable();

  if (!wantAi) {
    return {
      suggestions,
      aiUsed: false,
      aiError: unmatched.length > 0 && !aiMappingAvailable() ? null : null,
      unresolved: unmatched.length,
    };
  }

  const availableCandidates = input.candidates.filter((c) => !takenCandidates.has(c.id));
  if (availableCandidates.length === 0) {
    return { suggestions, aiUsed: false, aiError: null, unresolved: unmatched.length };
  }

  try {
    const aiMatches = await askClaude(input, unmatched, availableCandidates);
    const used = new Set(takenCandidates);
    for (const match of aiMatches) {
      if (!match.skuId || match.confidence < threshold) continue;
      if (used.has(match.skuId)) continue;
      if (!availableCandidates.some((c) => c.id === match.skuId)) continue;
      if (!unmatched.some((t) => t.id === match.variantId)) continue;
      used.add(match.skuId);
      suggestions.push({
        targetId: match.variantId,
        candidateId: match.skuId,
        confidence: Math.min(0.95, Number(match.confidence.toFixed(3))),
        reason: match.reason,
        source: "AI",
      });
    }
    const resolved = new Set(suggestions.map((s) => s.targetId));
    return { suggestions, aiUsed: true, aiError: null, unresolved: input.targets.filter((t) => !resolved.has(t.id)).length };
  } catch (error) {
    logger.warn("AI mapping failed; keeping the deterministic result", { error });
    return { suggestions, aiUsed: false, aiError: errorMessage(error), unresolved: unmatched.length };
  }
}

interface AiMatch {
  variantId: string;
  skuId: string;
  confidence: number;
  reason: string;
}

async function askClaude(input: AiMappingInput, targets: MatchTarget[], candidates: MatchCandidate[]): Promise<AiMatch[]> {
  const client = new Anthropic();

  const variantLines = targets
    .map((t) => `- id=${t.id} | options: ${t.values.length ? t.values.join(" / ") : (t.label ?? "(none)")}`)
    .join("\n");
  const skuLines = candidates
    .map((c) => `- id=${c.id} | attributes: ${c.values.length ? c.values.join(" / ") : (c.label ?? "(none)")}${c.isAvailable === false ? " (out of stock)" : ""}`)
    .join("\n");

  const prompt = [
    `A Shopify product must be matched to a supplier's SKUs so that orders route to the right item.`,
    ``,
    `Shopify product: ${input.productTitle}`,
    `Supplier product: ${input.supplierTitle}`,
    input.optionNames.length ? `Shopify option names, in order: ${input.optionNames.join(", ")}` : "",
    ``,
    `Shopify variants still unmatched:`,
    variantLines,
    ``,
    `Supplier SKUs still free:`,
    skuLines,
    ``,
    `Match each variant to at most one SKU, and use each SKU at most once. The two sides often use different languages, different word order, marketing names ("Midnight" for black), pack descriptions ("Bundle A (2 cups + lid)" for "2-Pack With Lid"), or units written differently. A wrong match sends a customer the wrong product, so leave skuId empty rather than guess: only return a match you would defend. Confidence below 0.6 is discarded.`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.parse({
    model: env().AI_MAPPING_MODEL,
    max_tokens: 8000,
    output_config: { format: jsonSchemaOutputFormat(RESULT_SCHEMA), effort: "low" },
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to answer this mapping request.");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The model returned no structured result.");
  return parsed.matches as AiMatch[];
}
