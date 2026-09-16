import sanitize, { type IOptions } from "sanitize-html";

/**
 * The one place product description HTML is made safe.
 *
 * Descriptions arrive from three hostile or semi-trusted sources: a script
 * running on the supplier's page (the browser extension), supplier APIs, and a
 * language model reached through a third-party gateway. The import editor used
 * to render them straight into the embedded admin, and the only filter was a
 * regex that removed double-quoted `on*="..."` attributes — so
 * `<img src=x onerror=alert(1)>`, a single-quoted handler, `<svg onload>` or a
 * `javascript:` link all survived and ran in the app's origin, where script can
 * ask App Bridge for a session token and call every app action.
 *
 * A regex cannot win that game, so this is an allowlist: a tag, attribute, URL
 * scheme or CSS property that is not named below does not come out. The list is
 * what a storefront product page legitimately needs — headings, paragraphs,
 * lists, tables, images and links — plus the inline layout styles the AI landing
 * contract relies on (flex rows, widths, margins, colours). Anything able to
 * carry script or pull a remote resource other than an http(s) image is absent:
 * no event handlers, no `srcset`, no `url()` in CSS, no `data:` or
 * `javascript:` URLs, no `svg`, `iframe`, `object`, `form` or `style` block.
 */

const ALLOWED_TAGS = [
  "p", "br", "hr", "div", "span", "section", "article", "figure", "figcaption",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "blockquote", "pre", "code",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "caption", "colgroup", "col", "thead", "tbody", "tfoot", "tr", "th", "td",
  "details", "summary",
  "img", "a",
];

/**
 * A CSS value may not open a function that fetches or evaluates (`url(`,
 * `image-set(`, `expression(`), may not escape characters with a backslash
 * (the classic way to spell `url` without writing it), and may only use the
 * characters ordinary lengths, colours and keywords are written with.
 */
const SAFE_CSS_VALUE = /^(?![\s\S]*(?:url|image-set|image|element|expression|attr|var|src)\s*\()(?![\s\S]*\\)[-#%.,\s\w()'"/!+*]+$/i;

/**
 * Every property the AI landing contract lists as allowed
 * (app/domain/copy/lumora-contract.ts, section 8) must be here, or rewritten
 * pages silently lose it: the sanitizer runs on the model's output, on every
 * editor save and on every push, and rewritten descriptions are reused as the
 * model's worked examples. `background`, `table-layout`, `cursor` and
 * `overflow-x` were once missing, which stripped the tinted "Before you buy" and
 * shipping panels and the fixed layout of the specification table. The
 * `background` shorthand is safe only because SAFE_CSS_VALUE refuses `url(`,
 * `image-set(` and backslash escapes, so it can carry a colour and nothing else
 * that loads.
 */
const STYLE_PROPERTIES = [
  "color", "background", "background-color", "opacity", "cursor",
  "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-transform", "text-align", "text-decoration", "vertical-align", "white-space",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "width", "max-width", "min-width", "height", "max-height", "min-height",
  "display", "flex", "flex-wrap", "flex-direction", "flex-basis", "flex-grow", "flex-shrink", "gap", "row-gap", "column-gap", "align-items", "justify-content",
  "border", "border-top", "border-right", "border-bottom", "border-left", "border-color", "border-width", "border-style", "border-radius", "border-collapse",
  "list-style", "list-style-type", "object-fit", "box-sizing", "overflow", "overflow-x", "overflow-y", "table-layout",
];

const allowedStyles = Object.fromEntries(STYLE_PROPERTIES.map((property) => [property, [SAFE_CSS_VALUE]]));

/**
 * An image source the storefront can actually load: absolute http(s) only.
 * Image hosts sometimes write `//ae01.alicdn.com/...`, which is https in
 * practice. A relative path would resolve against the merchant's storefront and
 * show a broken image, so it is treated the same as a hostile scheme.
 */
function imageSource(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  return /^https?:\/\/[^\s]/i.test(absolute) ? absolute : "";
}

/**
 * A link target that goes somewhere on purpose. Checked on the decoded value, so
 * `java&#x09;script:` — which the parser turns into `java\tscript:` — fails the
 * test instead of slipping past a scheme check that expected a clean string.
 */
function linkHref(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
}

const SUPPLIER_DOMAINS = /(aliexpress|alibaba|cjdropshipping|taobao|1688)\.[a-z.]+/gi;

export interface SanitizeDescriptionOptions {
  /**
   * Also remove supplier self-promotion: every link is unwrapped to its text,
   * supplier domains are cut out of the visible text, and paragraphs left empty
   * are dropped. This is the "clean description" import setting.
   */
  stripSupplierLinks?: boolean;
}

function buildOptions({ stripSupplierLinks = false }: SanitizeDescriptionOptions): IOptions {
  return {
    allowedTags: stripSupplierLinks ? ALLOWED_TAGS.filter((tag) => tag !== "a") : ALLOWED_TAGS,
    // A tag that is not allowed loses its markup but keeps its text; script,
    // style, textarea, noscript and option lose their contents too
    // (sanitize-html's `nonTextTags`), so no script source leaks out as text.
    disallowedTagsMode: "discard",
    allowedAttributes: {
      "*": ["style", "title", "align"],
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "style"],
      td: ["colspan", "rowspan", "style", "align", "valign"],
      th: ["colspan", "rowspan", "scope", "style", "align", "valign"],
      col: ["span", "width"],
      ol: ["start", "type"],
    },
    allowedStyles: { "*": allowedStyles },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: false,
    // An <img> left without a usable src (a data: URI, javascript:) is a broken
    // image on the storefront; drop it instead of shipping the empty tag.
    // The paragraph test removes supplier domains itself because this filter sees
    // the text before `textFilter` does: `<p><a>aliexpress.com</a></p>` would
    // otherwise survive as an empty `<p></p>`.
    exclusiveFilter: (frame) =>
      (frame.tag === "img" && !frame.attribs.src) ||
      (stripSupplierLinks && frame.tag === "p" && !frame.text.replace(SUPPLIER_DOMAINS, "").trim() && frame.mediaChildren.length === 0),
    transformTags: {
      img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, src: imageSource(attribs.src) } }),
      a: (tagName, attribs) => {
        const next: Record<string, string> = {};
        for (const [name, value] of Object.entries(attribs)) {
          if (name === "rel") continue;
          if (name === "href") {
            const href = linkHref(value);
            if (href) next.href = href;
            continue;
          }
          next[name] = value;
        }
        // A link that opens a new tab must not hand the opener to the page it opens.
        if (next.target) next.rel = "noopener noreferrer nofollow";
        return { tagName, attribs: next };
      },
    },
    textFilter: stripSupplierLinks ? (text) => text.replace(SUPPLIER_DOMAINS, "") : undefined,
  };
}

const plainOptions = buildOptions({});
const strippingOptions = buildOptions({ stripSupplierLinks: true });

/** Allowlist-sanitize description HTML. Safe to call on already-clean HTML. */
export function sanitizeDescriptionHtml(html: string | null | undefined, options: SanitizeDescriptionOptions = {}): string {
  if (!html) return "";
  return sanitize(html, options.stripSupplierLinks ? strippingOptions : plainOptions).trim();
}
