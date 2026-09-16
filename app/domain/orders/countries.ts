/**
 * ISO 3166-1 alpha-2 lookup.
 *
 * Shopify addresses carry both `country` (a display name, localised to the shop)
 * and `countryCodeV2`. The code is the reliable one, but it is null on draft
 * orders, POS orders and some app-created orders, so we need to recover the code
 * from the name rather than pass "United States" downstream as if it were an ISO
 * code — which silently disables every country rule and is then rejected by the
 * supplier.
 *
 * The table is static rather than derived from `Intl.DisplayNames` so the result
 * does not change with the ICU build shipped in the container.
 */

/** Canonical English name for every alpha-2 code we accept. */
const ISO_NAMES: Record<string, string> = {
  AD: "Andorra", AE: "United Arab Emirates", AF: "Afghanistan", AG: "Antigua and Barbuda",
  AI: "Anguilla", AL: "Albania", AM: "Armenia", AO: "Angola", AQ: "Antarctica",
  AR: "Argentina", AS: "American Samoa", AT: "Austria", AU: "Australia", AW: "Aruba",
  AX: "Aland Islands", AZ: "Azerbaijan", BA: "Bosnia and Herzegovina", BB: "Barbados",
  BD: "Bangladesh", BE: "Belgium", BF: "Burkina Faso", BG: "Bulgaria", BH: "Bahrain",
  BI: "Burundi", BJ: "Benin", BL: "Saint Barthelemy", BM: "Bermuda", BN: "Brunei",
  BO: "Bolivia", BQ: "Caribbean Netherlands", BR: "Brazil", BS: "Bahamas", BT: "Bhutan",
  BV: "Bouvet Island", BW: "Botswana", BY: "Belarus", BZ: "Belize", CA: "Canada",
  CC: "Cocos (Keeling) Islands", CD: "Congo - Kinshasa", CF: "Central African Republic",
  CG: "Congo - Brazzaville", CH: "Switzerland", CI: "Cote d'Ivoire", CK: "Cook Islands",
  CL: "Chile", CM: "Cameroon", CN: "China", CO: "Colombia", CR: "Costa Rica", CU: "Cuba",
  CV: "Cape Verde", CW: "Curacao", CX: "Christmas Island", CY: "Cyprus", CZ: "Czechia",
  DE: "Germany", DJ: "Djibouti", DK: "Denmark", DM: "Dominica", DO: "Dominican Republic",
  DZ: "Algeria", EC: "Ecuador", EE: "Estonia", EG: "Egypt", EH: "Western Sahara",
  ER: "Eritrea", ES: "Spain", ET: "Ethiopia", FI: "Finland", FJ: "Fiji",
  FK: "Falkland Islands", FM: "Micronesia", FO: "Faroe Islands", FR: "France", GA: "Gabon",
  GB: "United Kingdom", GD: "Grenada", GE: "Georgia", GF: "French Guiana", GG: "Guernsey",
  GH: "Ghana", GI: "Gibraltar", GL: "Greenland", GM: "Gambia", GN: "Guinea",
  GP: "Guadeloupe", GQ: "Equatorial Guinea", GR: "Greece",
  GS: "South Georgia and the South Sandwich Islands", GT: "Guatemala", GU: "Guam",
  GW: "Guinea-Bissau", GY: "Guyana", HK: "Hong Kong SAR",
  HM: "Heard and McDonald Islands", HN: "Honduras", HR: "Croatia", HT: "Haiti",
  HU: "Hungary", ID: "Indonesia", IE: "Ireland", IL: "Israel", IM: "Isle of Man",
  IN: "India", IO: "British Indian Ocean Territory", IQ: "Iraq", IR: "Iran",
  IS: "Iceland", IT: "Italy", JE: "Jersey", JM: "Jamaica", JO: "Jordan", JP: "Japan",
  KE: "Kenya", KG: "Kyrgyzstan", KH: "Cambodia", KI: "Kiribati", KM: "Comoros",
  KN: "Saint Kitts and Nevis", KP: "North Korea", KR: "South Korea", KW: "Kuwait",
  KY: "Cayman Islands", KZ: "Kazakhstan", LA: "Laos", LB: "Lebanon", LC: "Saint Lucia",
  LI: "Liechtenstein", LK: "Sri Lanka", LR: "Liberia", LS: "Lesotho", LT: "Lithuania",
  LU: "Luxembourg", LV: "Latvia", LY: "Libya", MA: "Morocco", MC: "Monaco",
  MD: "Moldova", ME: "Montenegro", MF: "Saint Martin", MG: "Madagascar",
  MH: "Marshall Islands", MK: "North Macedonia", ML: "Mali", MM: "Myanmar (Burma)",
  MN: "Mongolia", MO: "Macao SAR", MP: "Northern Mariana Islands", MQ: "Martinique",
  MR: "Mauritania", MS: "Montserrat", MT: "Malta", MU: "Mauritius", MV: "Maldives",
  MW: "Malawi", MX: "Mexico", MY: "Malaysia", MZ: "Mozambique", NA: "Namibia",
  NC: "New Caledonia", NE: "Niger", NF: "Norfolk Island", NG: "Nigeria",
  NI: "Nicaragua", NL: "Netherlands", NO: "Norway", NP: "Nepal", NR: "Nauru",
  NU: "Niue", NZ: "New Zealand", OM: "Oman", PA: "Panama", PE: "Peru",
  PF: "French Polynesia", PG: "Papua New Guinea", PH: "Philippines", PK: "Pakistan",
  PL: "Poland", PM: "Saint Pierre and Miquelon", PN: "Pitcairn Islands",
  PR: "Puerto Rico", PS: "Palestinian Territories", PT: "Portugal", PW: "Palau",
  PY: "Paraguay", QA: "Qatar", RE: "Reunion", RO: "Romania", RS: "Serbia",
  RU: "Russia", RW: "Rwanda", SA: "Saudi Arabia", SB: "Solomon Islands",
  SC: "Seychelles", SD: "Sudan", SE: "Sweden", SG: "Singapore", SH: "Saint Helena",
  SI: "Slovenia", SJ: "Svalbard and Jan Mayen", SK: "Slovakia", SL: "Sierra Leone",
  SM: "San Marino", SN: "Senegal", SO: "Somalia", SR: "Suriname", SS: "South Sudan",
  ST: "Sao Tome and Principe", SV: "El Salvador", SX: "Sint Maarten", SY: "Syria",
  SZ: "Eswatini", TC: "Turks and Caicos Islands", TD: "Chad",
  TF: "French Southern Territories", TG: "Togo", TH: "Thailand", TJ: "Tajikistan",
  TK: "Tokelau", TL: "Timor-Leste", TM: "Turkmenistan", TN: "Tunisia", TO: "Tonga",
  TR: "Turkiye", TT: "Trinidad and Tobago", TV: "Tuvalu", TW: "Taiwan",
  TZ: "Tanzania", UA: "Ukraine", UG: "Uganda", UM: "U.S. Outlying Islands",
  US: "United States", UY: "Uruguay", UZ: "Uzbekistan", VA: "Vatican City",
  VC: "Saint Vincent and the Grenadines", VE: "Venezuela",
  VG: "British Virgin Islands", VI: "U.S. Virgin Islands", VN: "Vietnam",
  VU: "Vanuatu", WF: "Wallis and Futuna", WS: "Samoa", XK: "Kosovo", YE: "Yemen",
  YT: "Mayotte", ZA: "South Africa", ZM: "Zambia", ZW: "Zimbabwe",
};

/**
 * Names Shopify, carriers or merchants use that differ from the canonical one
 * above. Everything is matched after `normalizeName`, so punctuation and case
 * do not need entries of their own.
 */
const ALIASES: Record<string, string> = {
  "united states of america": "US",
  "usa": "US",
  "us": "US",
  "u s a": "US",
  "america": "US",
  "united kingdom of great britain and northern ireland": "GB",
  "great britain": "GB",
  "uk": "GB",
  "england": "GB",
  "scotland": "GB",
  "wales": "GB",
  "northern ireland": "GB",
  "russian federation": "RU",
  "korea republic of": "KR",
  "republic of korea": "KR",
  "korea south": "KR",
  "south korea": "KR",
  "korea": "KR",
  "korea democratic peoples republic of": "KP",
  "north korea": "KP",
  "viet nam": "VN",
  "vietnam": "VN",
  "czech republic": "CZ",
  "czechia": "CZ",
  "slovak republic": "SK",
  "macedonia": "MK",
  "republic of north macedonia": "MK",
  "ivory coast": "CI",
  "cote divoire": "CI",
  "cape verde": "CV",
  "cabo verde": "CV",
  "swaziland": "SZ",
  "burma": "MM",
  "myanmar": "MM",
  "east timor": "TL",
  "holy see": "VA",
  "vatican": "VA",
  "laos": "LA",
  "lao peoples democratic republic": "LA",
  "syrian arab republic": "SY",
  "iran islamic republic of": "IR",
  "bolivia plurinational state of": "BO",
  "venezuela bolivarian republic of": "VE",
  "tanzania united republic of": "TZ",
  "moldova republic of": "MD",
  "republic of moldova": "MD",
  "brunei darussalam": "BN",
  "hong kong": "HK",
  "hong kong sar china": "HK",
  "macau": "MO",
  "macao": "MO",
  "macao sar china": "MO",
  "taiwan province of china": "TW",
  "turkey": "TR",
  "turkiye": "TR",
  "netherlands the": "NL",
  "the netherlands": "NL",
  "holland": "NL",
  "uae": "AE",
  "congo democratic republic of the": "CD",
  "democratic republic of the congo": "CD",
  "republic of the congo": "CG",
  "palestine state of": "PS",
  "palestine": "PS",
  "saint martin french part": "MF",
  "sint maarten dutch part": "SX",
  "bonaire sint eustatius and saba": "BQ",
  "curacao": "CW",
  "reunion": "RE",
  "aland islands": "AX",
  "falkland islands malvinas": "FK",
  "micronesia federated states of": "FM",
  "south georgia and the south sandwich islands": "GS",
  "virgin islands british": "VG",
  "virgin islands us": "VI",
  "united states minor outlying islands": "UM",
};

function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    // Strip combining marks so "Türkiye" and "Turkiye" agree.
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const BY_NAME: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [code, name] of Object.entries(ISO_NAMES)) {
    map.set(normalizeName(name), code);
  }
  for (const [name, code] of Object.entries(ALIASES)) {
    map.set(normalizeName(name), code);
  }
  return map;
})();

/** True when the value is already a plausible alpha-2 code. */
export function isIsoCountryCode(value: string | null | undefined): boolean {
  if (!value) return false;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) && Object.prototype.hasOwnProperty.call(ISO_NAMES, upper);
}

/**
 * Resolve an alpha-2 code from a code or a display name.
 *
 * Returns null rather than guessing, so the caller can raise MISSING_COUNTRY
 * instead of shipping a free-text country to the supplier.
 */
export function toCountryCode(
  code: string | null | undefined,
  name?: string | null,
): string | null {
  const fromCode = (code ?? "").trim().toUpperCase();
  if (isIsoCountryCode(fromCode)) return fromCode;

  // Shopify sometimes puts the display name in the code field, and vice versa.
  for (const candidate of [code, name]) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const upper = trimmed.toUpperCase();
    if (isIsoCountryCode(upper)) return upper;
    const matched = BY_NAME.get(normalizeName(trimmed));
    if (matched) return matched;
  }
  return null;
}

/** Display name for an alpha-2 code, for UI and error messages. */
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  return ISO_NAMES[code.trim().toUpperCase()] ?? null;
}

export const COUNTRY_CODES = Object.keys(ISO_NAMES);
