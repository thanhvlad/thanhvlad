import { useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLoaderData, useLocation, useNavigate } from "@remix-run/react";
import { Box, Page, Tabs } from "@shopify/polaris";
import type { SettingsOutletContext, SettingsPageAction } from "~/components/settings-page-action";
import { requireShop } from "~/lib/auth.server";
import type { I18nKey } from "~/lib/i18n";
import { useT } from "~/lib/use-t";
import { listAccountShops } from "~/services/shop.server";
import { listStaff } from "~/services/staff.server";

/**
 * The tabbed shell every settings screen sits in.
 *
 * The two tabs that hold a list carry their count, so a merchant sees how many
 * people and stores are on the account before opening the tab. Both counts
 * come from the same services the tabs themselves use.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const [staff, shops] = await Promise.all([shop.accountId ? listStaff(shop.accountId) : [], listAccountShops(shop.accountId)]);
  return { counts: { staff: staff.length, stores: shops.length } as Record<string, number> };
};

const TABS = [
  { id: "general", path: "/app/settings", labelKey: "settings.tabs.general", subtitleKey: "settings.shell.subtitle.general" },
  { id: "fulfillment", path: "/app/settings/fulfillment", labelKey: "settings.tabs.fulfillmentService", subtitleKey: "settings.shell.subtitle.fulfillment" },
  { id: "staff", path: "/app/settings/staff", labelKey: "settings.tabs.staff", subtitleKey: "settings.shell.subtitle.staff" },
  { id: "stores", path: "/app/settings/stores", labelKey: "settings.tabs.stores", subtitleKey: "settings.shell.subtitle.stores" },
  { id: "plan", path: "/app/settings/plan", labelKey: "settings.tabs.plan", subtitleKey: "settings.shell.subtitle.plan" },
  { id: "support", path: "/app/settings/support", labelKey: "settings.tabs.support", subtitleKey: "settings.shell.subtitle.support" },
  { id: "advanced", path: "/app/settings/advanced", labelKey: "settings.tabs.advanced", subtitleKey: "settings.shell.subtitle.advanced" },
] as const satisfies ReadonlyArray<{ id: string; path: string; labelKey: I18nKey; subtitleKey: I18nKey }>;

export default function SettingsLayout() {
  const { counts } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const [primaryAction, setPrimaryAction] = useState<SettingsPageAction | null>(null);
  const selected = Math.max(
    0,
    TABS.findIndex((tab) => (tab.path === "/app/settings" ? location.pathname === tab.path : location.pathname.startsWith(tab.path))),
  );
  const context: SettingsOutletContext = { setPrimaryAction };

  return (
    <Page title={t("page.settings.title")} subtitle={t(TABS[selected].subtitleKey)} primaryAction={primaryAction ?? undefined}>
      <Tabs
        tabs={TABS.map((tab) => ({
          id: tab.id,
          content: typeof counts[tab.id] === "number" ? `${t(tab.labelKey)} (${counts[tab.id]})` : t(tab.labelKey),
        }))}
        selected={selected}
        onSelect={(i) => navigate(TABS[i].path)}
      />
      <Box paddingBlockStart="400">
        <Outlet context={context} />
      </Box>
    </Page>
  );
}
