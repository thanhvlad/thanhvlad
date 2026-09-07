import type { LoaderFunctionArgs } from "@remix-run/node";
import { Outlet, useLocation, useNavigate } from "@remix-run/react";
import { Page, Tabs } from "@shopify/polaris";
import { requireShop } from "~/lib/auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireShop(request);
  return null;
};

const TABS = [
  { id: "general", path: "/app/settings", content: "General" },
  { id: "staff", path: "/app/settings/staff", content: "Staff" },
  { id: "stores", path: "/app/settings/stores", content: "Stores" },
  { id: "advanced", path: "/app/settings/advanced", content: "Advanced" },
];

export default function SettingsLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const selected = Math.max(0, TABS.findIndex((t) => (t.path === "/app/settings" ? location.pathname === t.path : location.pathname.startsWith(t.path))));
  return (
    <Page title="Settings">
      <Tabs tabs={TABS.map((t) => ({ id: t.id, content: t.content }))} selected={selected} onSelect={(i) => navigate(TABS[i].path)} />
      <div style={{ paddingTop: "var(--p-space-400)" }}>
        <Outlet />
      </div>
    </Page>
  );
}
