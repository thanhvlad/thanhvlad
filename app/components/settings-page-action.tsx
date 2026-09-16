import { useEffect, useRef } from "react";
import { useOutletContext } from "@remix-run/react";

/**
 * The settings screens share one `<Page>` (the tabbed shell in
 * `app.settings.tsx`), so a tab cannot render its own `primaryAction`. Instead
 * the shell hands each tab a setter through the outlet context, and the tab
 * registers the one thing a merchant most often does there — Save, Invite,
 * Route products — with its live `loading` / `disabled` state.
 *
 * The handler is read through a ref so a tab can pass a fresh closure on every
 * render (one that sees the latest form state) without re-registering the
 * action each time; only its visible facts (label, loading, disabled) do that.
 */
export interface SettingsPageAction {
  content: string;
  onAction?: () => void;
  url?: string;
  external?: boolean;
  loading?: boolean;
  disabled?: boolean;
}

export interface SettingsOutletContext {
  setPrimaryAction: (action: SettingsPageAction | null) => void;
}

export function useSettingsPageAction(action: SettingsPageAction | null) {
  const { setPrimaryAction } = useOutletContext<SettingsOutletContext>();
  const handler = useRef(action?.onAction);
  handler.current = action?.onAction;

  const present = Boolean(action);
  const content = action?.content;
  const url = action?.url;
  const external = action?.external;
  const loading = Boolean(action?.loading);
  const disabled = Boolean(action?.disabled);

  useEffect(() => {
    if (!present || !content) {
      setPrimaryAction(null);
      return;
    }
    setPrimaryAction({
      content,
      url,
      external,
      loading,
      disabled,
      onAction: url ? undefined : () => handler.current?.(),
    });
  }, [present, content, url, external, loading, disabled, setPrimaryAction]);

  useEffect(() => () => setPrimaryAction(null), [setPrimaryAction]);
}
