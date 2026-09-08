import { useRouteLoaderData } from "@remix-run/react";
import { makeT, type I18nKey, type I18nVars, type Locale, type Translator } from "./i18n";

/**
 * Translator bound to the shop's chosen language.
 *
 * The locale is loaded once by the `/app` layout route; every page reads it from
 * there rather than re-querying, so switching language in Settings takes effect
 * on the next navigation without extra requests.
 */
export function useT(): Translator {
  const data = useRouteLoaderData("routes/app") as { locale?: Locale } | undefined;
  return makeT(data?.locale ?? "en");
}

export function useLocale(): Locale {
  const data = useRouteLoaderData("routes/app") as { locale?: Locale } | undefined;
  return data?.locale ?? "en";
}

/**
 * Text for an action's result banner.
 *
 * Actions run on the server, where `useT` cannot be called, so they return a
 * translation key and its values rather than a finished English sentence — that
 * is what stopped a Vietnamese merchant from seeing "Saved." after every save.
 * A plain `message` is still honoured for anything that carries supplier or
 * Shopify text we do not translate.
 */
export function useMessage(
  result:
    | { message?: string | null; messageKey?: string | null; messageVars?: I18nVars | null }
    | undefined
    | null,
): string | undefined {
  const t = useT();
  if (!result) return undefined;
  if (result.messageKey) {
    return t(result.messageKey as I18nKey, result.messageVars ?? undefined) ?? result.message ?? undefined;
  }
  return result.message ?? undefined;
}

/**
 * Text for an action's failure banner.
 *
 * Most failures carry supplier or Shopify text and are shown as they are. A
 * failure the app itself raised — a plan limit, for instance — carries a key
 * instead, so a Vietnamese merchant is not told in English what to do next.
 */
export function useErrorMessage(
  result:
    | { ok?: boolean; error?: string | null; errorKey?: string | null; errorVars?: I18nVars | null }
    | undefined
    | null,
): string | undefined {
  const t = useT();
  if (!result || result.ok) return undefined;
  if (result.errorKey) {
    return t(result.errorKey as I18nKey, result.errorVars ?? undefined) ?? result.error ?? undefined;
  }
  return result.error ?? undefined;
}
