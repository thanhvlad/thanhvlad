/**
 * Deterministic checks on a rewritten landing page.
 *
 * The rewrite publishes to a live storefront with no human review, so the model
 * is not the last word on whether its own output is publishable. Everything the
 * contract states that can be verified by counting is verified here, before the
 * page reaches Shopify. A page that fails is not published: it is returned with
 * its reasons, which is the only way a merchant ever learns the rules were bent.
 *
 * Pure and dependency-free so it can be unit-tested without a model or a store.
 */

const EM_DASH = "—";

/** Tags the store's own 29 finished pages use. Everything else is forbidden. */
const ALLOWED_TAGS = new Set([
  "div", "p", "h2", "h3", "strong", "em", "ul", "ol", "li",
  "table", "tr", "td", "th", "details", "summary", "img", "a", "br",
]);

/** Zero occurrences store-wide. `class` and `id` are the giveaways of markup
 * copied from somewhere else, and a theme cannot be relied on to style them. */
const FORBIDDEN_ATTRS = /\s(class|id|onclick|onerror|onload|srcset|data-[a-z-]+)\s*=/i;

const ALLOWED_HREF = "mailto:support@lumoraloves.com";

/**
 * The supplier register. Each entry is a phrase measured at zero uses across the
 * 29 finished pages and present in the unrewritten imports - so a hit means the
 * model reproduced the thing this feature exists to remove.
 */
const BANNED: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bpremium\b/i, label: "premium" },
  { pattern: /\beffortless(ly)?\b/i, label: "effortless" },
  { pattern: /\ba thing of the past\b/i, label: "a thing of the past" },
  { pattern: /\binnovative\b/i, label: "innovative" },
  { pattern: /\bwherever your journey takes you\b/i, label: "wherever your journey takes you" },
  { pattern: /\bsleek\b/i, label: "sleek" },
  { pattern: /\bin today'?s fast[- ]paced\b/i, label: "in today's fast-paced" },
  { pattern: /\bsay goodbye to\b/i, label: "say goodbye to" },
  { pattern: /\bultimate\b/i, label: "ultimate" },
  { pattern: /\bingenious\b/i, label: "ingenious" },
  { pattern: /\bcleverly designed\b/i, label: "cleverly designed" },
  { pattern: /\bcrafted from\b/i, label: "crafted from" },
  { pattern: /\bhigh[- ](quality|grade)\b/i, label: "high-quality" },
  { pattern: /\b(ultra[- ]durable|heavy[- ]duty|state[- ]of[- ]the[- ]art|luxurious)\b/i, label: "praise adjective" },
  { pattern: /(^|[.>]\s*)(featuring|equipped with|boasts)\b/i, label: "Featuring / Equipped with / Boasts as an opener" },
  { pattern: /\b(enhance|transform) your\b/i, label: "Enhance/Transform Your" },
  { pattern: /\bwhy it is essential\b/i, label: "Why It Is Essential" },
  { pattern: /\b100% safe\b/i, label: "100% safe" },
  { pattern: /\b(perfect|ideal) for\b/i, label: "perfect/ideal for" },
  { pattern: /\bfor every occasion\b/i, label: "for every occasion" },
  { pattern: /\b(hassle[- ]free|universally loved|thoughtful gift)\b/i, label: "marketing filler" },
  { pattern: /\bwhether you (are|'re)\b[^.]*\bor\b/i, label: "whether you are X or Y" },
  { pattern: /\b(ensures|guarantees|allows you to)\b/i, label: "outcome promise" },
];

export interface RewriteCheckInput {
  title: string;
  descriptionHtml: string;
  tags: string[];
  heroImageIndex: number;
  imageCount: number;
}

export interface RewriteCheck {
  ok: boolean;
  failures: string[];
  /** Non-fatal observations worth surfacing next to a published page. */
  warnings: string[];
  wordCount: number;
}

/** Strip tags and collapse whitespace, so prose rules are measured on prose. */
export function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Clause count for a title tail. Commas between digits are thousands
 * separators - "3,500 sq ft" is one clause, not two. */
export function tailClauseCount(tail: string): number {
  return tail.replace(/(\d),(\d)/g, "$1$2").split(",").filter((s) => s.trim()).length;
}

export function checkTitle(title: string): string[] {
  const failures: string[] = [];
  const t = title.trim();

  if (t.length < 51 || t.length > 81) failures.push(`Title is ${t.length} characters; the contract allows 51 to 81.`);
  if (/[|:;]/.test(t)) failures.push("Title contains | : or ; — none is allowed.");
  if (/[.!?]$/.test(t)) failures.push("Title ends in terminal punctuation.");
  if (t.includes("!")) failures.push("Title contains an exclamation mark.");

  const dashes = (t.match(new RegExp(EM_DASH, "g")) ?? []).length;
  if (dashes > 1) failures.push(`Title has ${dashes} em dashes; at most one is allowed.`);
  if (dashes === 1) {
    if (!t.includes(` ${EM_DASH} `)) failures.push("The em dash must be spaced on both sides.");
    const tail = t.split(EM_DASH)[1] ?? "";
    const clauses = tailClauseCount(tail);
    if (clauses > 3) failures.push(`The title tail has ${clauses} clauses; at most three are allowed.`);
    const head = (t.split(EM_DASH)[0] ?? "").trim();
    if (head.includes(",")) failures.push("The title head contains a comma; enumerate in the tail instead.");
  }
  return failures;
}

export function checkHtml(html: string): string[] {
  const failures: string[] = [];

  const used = new Set<string>();
  for (const m of html.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g)) used.add(m[1].toLowerCase());
  for (const tag of used) {
    if (!ALLOWED_TAGS.has(tag)) failures.push(`Forbidden tag <${tag}>.`);
  }

  if (FORBIDDEN_ATTRS.test(html)) failures.push("Forbidden attribute (class, id, data-*, or an event handler).");

  for (const m of html.matchAll(/<a[^>]*href\s*=\s*["']([^"']*)["']/gi)) {
    if (m[1] !== ALLOWED_HREF) failures.push(`Link to ${m[1]}; the only permitted href is ${ALLOWED_HREF}.`);
  }

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(m[0]);
    if (!alt || !alt[1].trim()) failures.push("An image has no descriptive alt text.");
  }

  return failures;
}

export function checkRewrite(input: RewriteCheckInput): RewriteCheck {
  const failures: string[] = [];
  const warnings: string[] = [];

  failures.push(...checkTitle(input.title));
  failures.push(...checkHtml(input.descriptionHtml));

  const text = visibleText(input.descriptionHtml);
  const wordCount = text ? text.split(/\s+/).length : 0;
  if (wordCount < 900) failures.push(`Body is ${wordCount} words; the contract requires at least 900.`);
  if (wordCount > 2100) failures.push(`Body is ${wordCount} words; the contract allows at most 2,100.`);

  for (const { pattern, label } of BANNED) {
    if (pattern.test(text) || pattern.test(input.title)) {
      failures.push(`Banned supplier register: "${label}".`);
    }
  }

  if (text.includes("!")) failures.push("The body contains an exclamation mark.");
  // Emoji and other pictographs: zero across the whole corpus.
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) failures.push("The body contains an emoji.");

  if (input.tags.length < 8 || input.tags.length > 12) {
    failures.push(`${input.tags.length} tags; the contract requires 8 to 12.`);
  }
  const upper = input.tags.filter((t) => t !== t.toLowerCase());
  if (upper.length) failures.push(`Tags must be lowercase: ${upper.join(", ")}.`);

  if (!Number.isInteger(input.heroImageIndex) || input.heroImageIndex < 0 || input.heroImageIndex >= Math.max(1, input.imageCount)) {
    failures.push(`Hero image index ${input.heroImageIndex} is outside the ${input.imageCount} supplied images.`);
  }

  // Contractions are style, not safety: 2 in 35,630 corpus words, so a stray one
  // is worth showing the merchant without blocking an otherwise sound page.
  const contractions = text.match(/\b\w+'(s|t|re|ve|ll|d|m)\b/gi) ?? [];
  const nonPossessive = contractions.filter((c) => !/'s$/i.test(c));
  if (nonPossessive.length) warnings.push(`${nonPossessive.length} contraction(s): ${[...new Set(nonPossessive)].slice(0, 5).join(", ")}.`);

  return { ok: failures.length === 0, failures, warnings, wordCount };
}
