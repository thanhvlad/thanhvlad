import type { LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLocation, useNavigate } from "@remix-run/react";
import { Page, Tabs } from "@shopify/polaris";
import { requireShop } from "~/lib/auth.server";
import { useT } from "~/lib/use-t";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireShop(request);
  return null;
};

const TABS = [
  { id: "general", path: "/app/settings", labelKey: "settings.tabs.general" },
  { id: "fulfillment", path: "/app/settings/fulfillment", labelKey: "settings.tabs.fulfillmentService" },
  { id: "staff", path: "/app/settings/staff", labelKey: "settings.tabs.staff" },
  { id: "stores", path: "/app/settings/stores", labelKey: "settings.tabs.stores" },
  { id: "plan", path: "/app/settings/plan", labelKey: "settings.tabs.plan" },
  { id: "advanced", path: "/app/settings/advanced", labelKey: "settings.tabs.advanced" },
] as const;

export default function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const selected = Math.max(0, TABS.findIndex((tab) => (tab.path === "/app/settings" ? location.pathname === tab.path : location.pathname.startsWith(tab.path))));
  return (
    <Page title={t("page.settings.title")}>
      <Tabs tabs={TABS.map((tab) => ({ id: tab.id, content: t(tab.labelKey) }))} selected={selected} onSelect={(i) => navigate(TABS[i].path)} />
      <div style={{ paddingTop: "var(--p-space-400)" }}>
        <Outlet />
      </div>
    </Page>
  );
}
