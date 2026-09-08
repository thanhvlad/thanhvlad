import { useRouteLoaderData } from "@remix-run/react";
import { makeT, type Locale, type Translator } from "./i18n";

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
