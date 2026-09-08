import { toCountryCode } from "./countries";

export interface ShippingAddress {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  country?: string | null;
  countryCode?: string | null;
  phone?: string | null;
  /** Tax/identity number some destinations require at customs. */
  taxNumber?: string | null;
}

export type AddressIssueCode =
  | "MISSING_NAME"
  | "MISSING_ADDRESS1"
  | "MISSING_CITY"
  | "MISSING_ZIP"
  | "INVALID_ZIP"
  | "MISSING_PROVINCE"
  | "MISSING_COUNTRY"
  | "MISSING_PHONE"
  | "INVALID_PHONE"
  | "ADDRESS1_TOO_LONG"
  | "NAME_TOO_LONG"
  | "MISSING_TAX_ID"
  | "INVALID_TAX_ID"
  | "NON_LATIN_CHARACTERS";

export interface AddressIssue {
  code: AddressIssueCode;
  field: keyof ShippingAddress;
  message: string;
  /** Blocking issues stop the order; warnings let it through. */
  severity: "error" | "warning";
  /** A value we can apply automatically to fix it, when one exists. */
  suggestion?: string;
}

export interface AddressValidationResult {
  ok: boolean;
  issues: AddressIssue[];
  /** The address after safe automatic clean-ups. */
  normalized: ShippingAddress;
}

/** Countries where Shopify/carriers expect a state or province code. */
const PROVINCE_REQUIRED = new Set([
  "US", "CA", "AU", "CN", "JP", "IT", "ES", "MX", "BR", "IN", "MY", "AR", "ID", "TH", "IE",
]);

/**
 * Destinations that genuinely have no postal codes.
 *
 * South Africa (4-digit codes) and Ireland (Eircode, since 2015) are NOT in this
 * list even though they are often mistaken for postal-code-free countries —
 * carriers reject their addresses without one, and the supplier order fails far
 * later than validation would have. Netherlands Antilles ("AN") is gone since
 * 2010 and is not listed either.
 */
const NO_ZIP = new Set([
  "AE", "AO", "AG", "AW", "BS", "BZ", "BJ", "BW", "BF", "BI", "CM", "CF", "KM", "CG", "CD",
  "CK", "CI", "DJ", "DM", "GQ", "ER", "FJ", "TF", "GM", "GH", "GD", "GY", "HK", "JM",
  "KE", "KI", "KP", "LY", "MO", "MW", "ML", "MR", "MU", "MS", "NR", "NU", "PA",
  "QA", "RW", "KN", "LC", "ST", "SC", "SL", "SB", "SO", "SR", "SY", "TZ", "TL", "TK",
  "TO", "TT", "TV", "UG", "VU", "YE", "ZW",
]);

/**
 * Identity documents required at customs. `pattern` is validated after
 * stripping punctuation; `label` is what the merchant sees in the UI.
 */
const TAX_ID_RULES: Record<string, { label: string; pattern: RegExp; hint: string }> = {
  BR: { label: "CPF", pattern: /^\d{11}$/, hint: "11 digits, e.g. 123.456.789-09" },
  CL: { label: "RUT", pattern: /^\d{7,9}[0-9kK]$/, hint: "8-9 digits plus check digit" },
  KR: {
    label: "Personal Customs Clearance Code",
    pattern: /^[Pp]\d{12}$/,
    hint: "P followed by 12 digits",
  },
  TR: { label: "T.C. Kimlik No", pattern: /^\d{11}$/, hint: "11 digits" },
  AR: { label: "DNI/CUIT", pattern: /^\d{7,11}$/, hint: "7-11 digits" },
  EC: { label: "Cédula/RUC", pattern: /^\d{10,13}$/, hint: "10 or 13 digits" },
  PE: { label: "DNI", pattern: /^\d{8,11}$/, hint: "8-11 digits" },
  ZA: { label: "ID number", pattern: /^\d{13}$/, hint: "13 digits" },
  IT: { label: "Codice Fiscale", pattern: /^[A-Za-z0-9]{11,16}$/, hint: "11-16 characters" },
  ES: { label: "NIF/NIE", pattern: /^[A-Za-z0-9]{8,9}$/, hint: "8-9 characters" },
};

const ZIP_PATTERNS: Record<string, RegExp> = {
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/,
  GB: /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  AU: /^\d{4}$/,
  NL: /^\d{4}\s?[A-Za-z]{2}$/,
  BR: /^\d{5}-?\d{3}$/,
  JP: /^\d{3}-?\d{4}$/,
  IN: /^\d{6}$/,
  CN: /^\d{6}$/,
  PL: /^\d{2}-?\d{3}$/,
  SE: /^\d{3}\s?\d{2}$/,
  MX: /^\d{5}$/,
  ZA: /^\d{4}$/,
  // Eircode: routing key + 4 alphanumerics, e.g. "D02 AF30".
  IE: /^[A-Za-z]\d{2}\s?[A-Za-z\d]{4}$/,
};

/** Most suppliers reject an address line longer than this. */
const MAX_ADDRESS1 = 128;
const MAX_ADDRESS2 = 128;
const MAX_NAME = 50;

/**
 * `\p{M}` is required: accented Latin text in NFD form (what macOS, iOS and some
 * checkout inputs produce) is a base letter plus a combining mark, and without it
 * an ordinary "José" is flagged as non-Latin.
 */
const LATIN_ONLY = /^[\p{Script=Latin}\p{M}\p{Nd}\p{P}\p{Zs}\p{S}]*$/u;

export function fullName(address: ShippingAddress): string {
  if (address.name?.trim()) return address.name.trim();
  return [address.firstName, address.lastName].filter(Boolean).join(" ").trim();
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function joinAddress2(overflow: string, existing?: string | null): string {
  return [overflow, existing].filter(Boolean).join(", ");
}

/**
 * Validate a shipping address for a cross-border dropshipping order.
 *
 * `requireLatin` is on for AliExpress-style suppliers whose order API rejects
 * non-Latin scripts outside a handful of localised markets.
 */
export function validateAddress(
  input: ShippingAddress,
  options: { requireLatin?: boolean; requireTaxId?: boolean } = {},
): AddressValidationResult {
  const issues: AddressIssue[] = [];
  // Never let a display name ("United States") reach downstream code as if it
  // were an ISO code: it matches no country rule and the supplier rejects it.
  const country = toCountryCode(input.countryCode, input.country) ?? "";
  const rawCountry = (input.countryCode ?? input.country ?? "").trim();

  const normalized: ShippingAddress = {
    ...input,
    firstName: input.firstName?.trim() ?? null,
    lastName: input.lastName?.trim() ?? null,
    name: fullName(input) || null,
    address1: input.address1?.trim().replace(/\s+/g, " ") ?? null,
    address2: input.address2?.trim().replace(/\s+/g, " ") ?? null,
    city: input.city?.trim() ?? null,
    zip: input.zip?.trim().toUpperCase() ?? null,
    phone: input.phone?.trim() ?? null,
    countryCode: country || null,
  };

  const name = normalized.name ?? "";
  if (!name) {
    issues.push({
      code: "MISSING_NAME",
      field: "name",
      severity: "error",
      message: "The recipient name is empty.",
    });
  } else if (name.length > MAX_NAME) {
    issues.push({
      code: "NAME_TOO_LONG",
      field: "name",
      severity: "error",
      message: `The recipient name is ${name.length} characters; suppliers accept at most ${MAX_NAME}.`,
      suggestion: name.slice(0, MAX_NAME).trim(),
    });
  }

  if (!country) {
    issues.push({
      code: "MISSING_COUNTRY",
      field: "countryCode",
      severity: "error",
      message: rawCountry
        ? `"${rawCountry}" is not a country we recognise. Set the destination country on the order.`
        : "The destination country is missing.",
    });
  }

  if (!normalized.address1) {
    issues.push({
      code: "MISSING_ADDRESS1",
      field: "address1",
      severity: "error",
      message: "The street address is empty.",
    });
  } else if (normalized.address1.length > MAX_ADDRESS1) {
    // Overflow into address2 rather than truncating away part of the address.
    // A suggestion is only offered when the overflow actually fits on line 2 —
    // otherwise the "fix" would silently drop part of the street address and
    // re-validation would report the order as clean.
    const cut = normalized.address1.slice(0, MAX_ADDRESS1);
    const boundary = cut.lastIndexOf(" ");
    const keep = (boundary > 40 ? cut.slice(0, boundary) : cut).trim();
    const line2 = joinAddress2(normalized.address1.slice(keep.length).trim(), normalized.address2);
    const fits = line2.length <= MAX_ADDRESS2;
    issues.push({
      code: "ADDRESS1_TOO_LONG",
      field: "address1",
      severity: "error",
      message: fits
        ? `Address line 1 is ${normalized.address1.length} characters; the limit is ${MAX_ADDRESS1}. Move the overflow to line 2.`
        : `Address line 1 is ${normalized.address1.length} characters and the overflow does not fit on line 2 either (${MAX_ADDRESS1} each). Shorten the address before ordering.`,
      ...(fits ? { suggestion: keep } : {}),
    });
  }

  if (!normalized.city) {
    issues.push({
      code: "MISSING_CITY",
      field: "city",
      severity: "error",
      message: "The city is empty.",
    });
  }

  if (country && PROVINCE_REQUIRED.has(country) && !input.province && !input.provinceCode) {
    issues.push({
      code: "MISSING_PROVINCE",
      field: "province",
      severity: "error",
      message: `${country} orders need a state or province.`,
    });
  }

  if (country && !NO_ZIP.has(country)) {
    if (!normalized.zip) {
      issues.push({
        code: "MISSING_ZIP",
        field: "zip",
        severity: "error",
        message: `${country} orders need a postal code.`,
      });
    } else {
      const pattern = ZIP_PATTERNS[country];
      if (pattern && !pattern.test(normalized.zip)) {
        issues.push({
          code: "INVALID_ZIP",
          field: "zip",
          severity: "warning",
          message: `"${normalized.zip}" does not look like a valid ${country} postal code.`,
        });
      }
    }
  }

  if (!normalized.phone) {
    issues.push({
      code: "MISSING_PHONE",
      field: "phone",
      severity: "error",
      message: "Suppliers require a contact phone number for the courier.",
    });
  } else {
    const digits = digitsOnly(normalized.phone);
    if (digits.length < 6 || digits.length > 15) {
      issues.push({
        code: "INVALID_PHONE",
        field: "phone",
        severity: "warning",
        message: `"${normalized.phone}" has ${digits.length} digits; a valid number has 6-15.`,
      });
    }
  }

  const taxRule = country ? TAX_ID_RULES[country] : undefined;
  if (taxRule) {
    // Merchants often stash the document number in the company field.
    const candidate = (input.taxNumber ?? input.company ?? "").trim();
    const cleaned = candidate.replace(/[^A-Za-z0-9]/g, "");
    if (!cleaned) {
      if (options.requireTaxId !== false) {
        issues.push({
          code: "MISSING_TAX_ID",
          field: "taxNumber",
          severity: "error",
          message: `${country} customs requires a ${taxRule.label} (${taxRule.hint}).`,
        });
      }
    } else if (!taxRule.pattern.test(cleaned)) {
      issues.push({
        code: "INVALID_TAX_ID",
        field: "taxNumber",
        severity: "error",
        message: `"${candidate}" is not a valid ${taxRule.label} (${taxRule.hint}).`,
      });
    } else {
      normalized.taxNumber = cleaned;
    }
  }

  if (options.requireLatin) {
    const combined = [name, normalized.address1, normalized.address2, normalized.city]
      .filter(Boolean)
      .join(" ");
    if (combined && !LATIN_ONLY.test(combined)) {
      issues.push({
        code: "NON_LATIN_CHARACTERS",
        field: "address1",
        severity: "warning",
        message:
          "The address contains non-Latin characters. Some suppliers reject these; transliterate before ordering.",
      });
    }
  }

  return {
    ok: issues.every((i) => i.severity !== "error"),
    issues,
    normalized,
  };
}

/** Apply every `suggestion` an issue carries, for one-click "fix address". */
export function applySuggestions(
  address: ShippingAddress,
  issues: AddressIssue[],
): ShippingAddress {
  const next: ShippingAddress = { ...address };
  for (const issue of issues) {
    if (!issue.suggestion) continue;
    if (issue.code === "ADDRESS1_TOO_LONG") {
      const original = (address.address1 ?? "").trim().replace(/\s+/g, " ");
      // Only split when the suggestion is genuinely a prefix of the address and
      // the remainder fits on line 2. Anything else is left for the merchant to
      // correct — shipping a silently truncated street address is worse than
      // blocking the order.
      if (!original.startsWith(issue.suggestion)) continue;
      const line2 = joinAddress2(original.slice(issue.suggestion.length).trim(), address.address2);
      if (line2.length > MAX_ADDRESS2) continue;
      next.address1 = issue.suggestion;
      next.address2 = line2;
      continue;
    }
    (next as Record<string, unknown>)[issue.field] = issue.suggestion;
  }
  return next;
}

export const ADDRESS_RULES = {
  PROVINCE_REQUIRED,
  NO_ZIP,
  TAX_ID_RULES,
  ZIP_PATTERNS,
  MAX_ADDRESS1,
  MAX_ADDRESS2,
  MAX_NAME,
};
