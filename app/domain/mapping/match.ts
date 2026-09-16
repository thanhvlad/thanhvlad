/**
 * Deterministic variant matching.
 *
 * Shopify option values and supplier option values rarely agree character for
 * character: "Black" vs "black", "XL" vs "Extra Large", "Đen" vs "Black",
 * "China" vs "CN", "2 Pcs" vs "2pcs". This module scores every possible pairing
 * and picks a stable assignment, with a confidence the UI can show.
 *
 * It never calls a network service; the AI mapper in
 * app/services/ai-mapping.server.ts only sees what this could not resolve.
 */

export interface MatchTarget {
  id: string;
  /** Option values in the product's option order, e.g. ["Red", "XL"]. */
  values: string[];
  /** Fallback label when there are no option values (e.g. the variant title). */
  label?: string;
}

export interface MatchCandidate {
  id: string;
  values: string[];
  label?: string;
  /** Out-of-stock candidates are matched but ranked below in-stock ones. */
  isAvailable?: boolean;
}

export interface MatchAssignment {
  targetId: string;
  candidateId: string | null;
  /** 0-1. Above `threshold` the row is proposed; below it the row is left open. */
  confidence: number;
  reason: string;
}

export interface MatchResult {
  assignments: MatchAssignment[];
  /** Targets with no candidate above the threshold — the AI mapper's input. */
  unmatched: MatchTarget[];
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Colour words that mean the same thing, keyed by canonical English name. */
const COLOR_SYNONYMS: Record<string, string[]> = {
  black: ["black", "noir", "negro", "schwarz", "nero", "preto", "чёрный", "черный", "黑", "黑色", "den", "đen", "hitam"],
  white: ["white", "blanc", "blanco", "weiss", "weiß", "bianco", "branco", "белый", "白", "白色", "trang", "trắng", "putih"],
  red: ["red", "rouge", "rojo", "rot", "rosso", "vermelho", "красный", "红", "红色", "do", "đỏ", "merah"],
  blue: ["blue", "bleu", "azul", "blau", "blu", "синий", "蓝", "蓝色", "xanh duong", "xanh dương", "biru"],
  green: ["green", "vert", "verde", "grun", "grün", "зелёный", "зеленый", "绿", "绿色", "xanh la", "xanh lá", "hijau"],
  yellow: ["yellow", "jaune", "amarillo", "gelb", "giallo", "жёлтый", "желтый", "黄", "黄色", "vang", "vàng", "kuning"],
  pink: ["pink", "rose", "rosa", "розовый", "粉", "粉色", "hong", "hồng", "merah muda"],
  purple: ["purple", "violet", "morado", "lila", "viola", "фиолетовый", "紫", "紫色", "tim", "tím", "ungu"],
  grey: ["grey", "gray", "gris", "grau", "grigio", "cinza", "серый", "灰", "灰色", "xam", "xám", "abu"],
  brown: ["brown", "marron", "marrón", "braun", "marrone", "коричневый", "棕", "棕色", "nau", "nâu", "coklat"],
  orange: ["orange", "naranja", "arancione", "оранжевый", "橙", "橙色", "cam"],
  beige: ["beige", "bege", "бежевый", "米色", "be"],
  gold: ["gold", "golden", "or", "dorado", "oro", "золотой", "金", "金色", "vang kim", "vàng kim"],
  silver: ["silver", "argent", "plata", "silber", "argento", "серебряный", "银", "银色", "bac", "bạc"],
  navy: ["navy", "navyblue", "dark blue", "darkblue", "bleu marine", "azul marino", "海军蓝", "xanh navy"],
  khaki: ["khaki", "caqui", "хаки", "卡其", "卡其色"],
  transparent: ["transparent", "clear", "prozrachnyj", "透明", "trong suot", "trong suốt"],
  multicolor: ["multicolor", "multi color", "multicolour", "colorful", "rainbow", "彩色", "nhieu mau", "nhiều màu"],
};

/** Size words, keyed by canonical short form. */
const SIZE_SYNONYMS: Record<string, string[]> = {
  xxs: ["xxs", "xx small", "xx-small", "2xs"],
  xs: ["xs", "x small", "x-small", "extra small", "extrasmall"],
  s: ["s", "small", "sm", "petit", "pequeno", "klein", "nho", "nhỏ"],
  m: ["m", "medium", "med", "moyen", "mediano", "mittel", "vua", "vừa"],
  l: ["l", "large", "lg", "grand", "grande", "gross", "groß", "lon", "lớn"],
  xl: ["xl", "x large", "x-large", "extra large", "extralarge"],
  xxl: ["xxl", "2xl", "2 xl", "xx large", "xx-large", "double xl"],
  xxxl: ["xxxl", "3xl", "3 xl", "xxx large", "triple xl"],
  xxxxl: ["xxxxl", "4xl", "4 xl"],
  "5xl": ["5xl", "xxxxxl"],
  onesize: ["one size", "onesize", "free size", "freesize", "universal", "uni", "标准", "mot co", "một cỡ"],
};

/** Country / ship-from words. */
const COUNTRY_SYNONYMS: Record<string, string[]> = {
  cn: ["cn", "china", "chine", "中国", "china mainland", "trung quoc", "trung quốc"],
  us: ["us", "usa", "united states", "america", "美国", "my", "mỹ"],
  ru: ["ru", "russia", "russian federation", "россия", "nga"],
  es: ["es", "spain", "españa", "espana", "tay ban nha", "tây ban nha"],
  fr: ["fr", "france", "phap", "pháp"],
  de: ["de", "germany", "deutschland", "duc", "đức"],
  uk: ["uk", "gb", "united kingdom", "england", "britain", "anh"],
  au: ["au", "australia", "uc", "úc"],
  br: ["br", "brazil", "brasil"],
  vn: ["vn", "vietnam", "viet nam", "việt nam"],
};

const SYNONYM_INDEX = buildIndex([COLOR_SYNONYMS, SIZE_SYNONYMS, COUNTRY_SYNONYMS]);

function buildIndex(groups: Array<Record<string, string[]>>): Map<string, string> {
  const index = new Map<string, string>();
  for (const group of groups) {
    for (const [canonical, words] of Object.entries(group)) {
      index.set(canonical, canonical);
      for (const word of words) index.set(normalize(word), canonical);
    }
  }
  return index;
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalize(value: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d")
    .replace(/[^a-z0-9一-鿿Ѐ-ӿ]+/g, " ")
    // Suppliers write "50cm", merchants write "50 cm" — treat them alike.
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .trim()
    .replace(/\s+/g, " ");
}

/** Map a value onto its canonical form when we recognise it. */
export function canonical(value: string): string {
  const n = normalize(value);
  if (!n) return "";
  const direct = SYNONYM_INDEX.get(n);
  if (direct) return direct;
  // "dark blue 2pcs" → try the leading words too.
  const words = n.split(" ");
  for (let take = words.length - 1; take >= 1; take -= 1) {
    const prefix = words.slice(0, take).join(" ");
    const hit = SYNONYM_INDEX.get(prefix);
    if (hit) return hit;
  }
  for (const word of words) {
    const hit = SYNONYM_INDEX.get(word);
    if (hit) return hit;
  }
  return n;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** Similarity of two single option values, 0-1. */
export function valueSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ca = canonical(a);
  const cb = canonical(b);
  if (ca && ca === cb) return 0.97;

  // Numbers must agree when both sides carry them ("50cm" vs "60cm").
  const numbersA = na.match(/\d+/g);
  const numbersB = nb.match(/\d+/g);
  if (numbersA && numbersB && numbersA.join() !== numbersB.join()) {
    const shared = numbersA.filter((n) => numbersB.includes(n)).length;
    if (shared === 0) return 0;
  }

  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return 0.85;

  const tokensA = new Set(na.split(" "));
  const tokensB = new Set(nb.split(" "));
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  if (intersection > 0) {
    const jaccard = intersection / new Set([...tokensA, ...tokensB]).size;
    return 0.5 + 0.4 * jaccard;
  }

  const distance = levenshtein(na, nb);
  const similarity = 1 - distance / Math.max(na.length, nb.length);
  return similarity >= 0.7 ? similarity * 0.8 : 0;
}

/**
 * Similarity of two value sets, order-insensitive: option order often differs
 * between a Shopify product and the supplier's SKU attributes.
 */
export function variantSimilarity(a: string[], b: string[]): number {
  const left = a.filter((v) => normalize(v));
  const right = b.filter((v) => normalize(v));
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;

  const used = new Set<number>();
  let total = 0;
  for (const value of left) {
    let best = 0;
    let bestIndex = -1;
    for (let i = 0; i < right.length; i += 1) {
      if (used.has(i)) continue;
      const score = valueSimilarity(value, right[i]);
      if (score > best) {
        best = score;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) used.add(bestIndex);
    total += best;
  }
  const average = total / left.length;
  // A supplier SKU with extra attributes we do not model is still a fair match,
  // but less certain than an exact arity match.
  const arityPenalty = Math.min(left.length, right.length) / Math.max(left.length, right.length);
  return average * (0.7 + 0.3 * arityPenalty);
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

export interface MatchOptions {
  /** Minimum confidence to propose a row. Default 0.6. */
  threshold?: number;
  /** Allow one supplier SKU to serve several Shopify variants. Default false. */
  allowReuse?: boolean;
}

/**
 * Greedy best-first assignment. Every pair is scored, the strongest pairing is
 * taken first, and each side is then consumed — which is what makes the result
 * stable regardless of input order.
 */
export function matchVariants(targets: MatchTarget[], candidates: MatchCandidate[], options: MatchOptions = {}): MatchResult {
  const threshold = options.threshold ?? 0.6;
  const allowReuse = options.allowReuse ?? false;

  if (candidates.length === 0) {
    return { assignments: targets.map((t) => ({ targetId: t.id, candidateId: null, confidence: 0, reason: "No supplier SKUs to match against." })), unmatched: targets };
  }

  // A single-variant product against a single SKU is unambiguous — but only
  // when at least one side carries no distinguishing options. Two products that
  // both name their options and disagree ("Titanium Frame" vs "Cotton Bag") are
  // a mismatch, not a match of convenience.
  if (candidates.length === 1 && targets.length === 1) {
    const target = targets[0];
    const candidate = candidates[0];
    if (isOptionless(target.values) || isOptionless(candidate.values)) {
      return {
        assignments: [{ targetId: target.id, candidateId: candidate.id, confidence: 1, reason: "Single variant and a single supplier SKU." }],
        unmatched: [],
      };
    }
  }

  const pairs: Array<{ target: MatchTarget; candidate: MatchCandidate; score: number }> = [];
  for (const target of targets) {
    const targetValues = target.values.length ? target.values : splitLabel(target.label);
    for (const candidate of candidates) {
      const candidateValues = candidate.values.length ? candidate.values : splitLabel(candidate.label);
      let score = variantSimilarity(targetValues, candidateValues);
      // Prefer an in-stock SKU when two candidates score the same.
      if (candidate.isAvailable === false) score *= 0.98;
      pairs.push({ target, candidate, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id) || a.candidate.id.localeCompare(b.candidate.id));

  const assignedTargets = new Map<string, MatchAssignment>();
  const usedCandidates = new Set<string>();
  for (const pair of pairs) {
    if (assignedTargets.has(pair.target.id)) continue;
    if (!allowReuse && usedCandidates.has(pair.candidate.id)) continue;
    if (pair.score < threshold) continue;
    assignedTargets.set(pair.target.id, {
      targetId: pair.target.id,
      candidateId: pair.candidate.id,
      confidence: Number(pair.score.toFixed(3)),
      reason: describe(pair.score),
    });
    usedCandidates.add(pair.candidate.id);
  }

  const assignments = targets.map(
    (t) =>
      assignedTargets.get(t.id) ?? {
        targetId: t.id,
        candidateId: null,
        confidence: 0,
        reason: "No supplier SKU matched closely enough.",
      },
  );
  return { assignments, unmatched: targets.filter((t) => !assignedTargets.has(t.id)) };
}

/** No options, or only Shopify's placeholder option value. */
function isOptionless(values: string[]): boolean {
  const meaningful = values.map(normalize).filter((v) => v && v !== "default title" && v !== "title");
  return meaningful.length === 0;
}

function describe(score: number): string {
  if (score >= 0.99) return "Exact option match.";
  if (score >= 0.9) return "Option values are equivalent.";
  if (score >= 0.75) return "Option values are very similar.";
  return "Option values are loosely similar — please confirm.";
}

/** "Red / XL" or "Red-XL" → ["Red", "XL"]. */
export function splitLabel(label: string | undefined): string[] {
  if (!label) return [];
  return label
    .split(/[/|,;·•]+|\s-\s/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const MATCH_SYNONYMS = { COLOR_SYNONYMS, SIZE_SYNONYMS, COUNTRY_SYNONYMS };
