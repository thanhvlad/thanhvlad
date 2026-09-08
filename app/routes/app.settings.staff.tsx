import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import type { StaffRole } from "@prisma/client";
import { Badge, Banner, BlockStack, Box, Button, Card, FormLayout, InlineStack, Layout, Select, Text, TextField } from "@shopify/polaris";
import { readForm, requireShop } from "~/lib/auth.server";
import { actionFailure } from "~/lib/errors";
import { formatDate } from "~/lib/format";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
import { ROLE_PERMISSIONS, inviteStaff, listStaff, removeStaff, updateStaffRole } from "~/services/staff.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const staff = shop.accountId ? await listStaff(shop.accountId) : [];
  return { staff, permissions: ROLE_PERMISSIONS };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request);
  const { intent, get } = await readForm(request);
  if (!shop.accountId) return { ok: false, error: "Shop has no account." };
  try {
    switch (intent) {
      case "invite":
        await inviteStaff(shop.id, shop.accountId, { email: get("email"), name: get("name") || null, role: get("role") as StaffRole });
        return { ok: true, messageKey: "msg.staffInvited", messageVars: { email: get("email") } };
      case "role":
        await updateStaffRole(shop.id, get("id"), get("role") as StaffRole);
        return { ok: true, messageKey: "msg.roleUpdated" };
      case "remove":
        await removeStaff(shop.id, get("id"));
        return { ok: true, messageKey: "msg.memberRemoved" };
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return actionFailure(e);
  }
};

export default function StaffSettings() {
  const { staff } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(result as Parameters<typeof useErrorMessage>[0]);
  const [form, setForm] = useState({ email: "", name: "", role: "STAFF" as StaffRole });
  const t = useT();

  const roles: Array<{ label: string; value: StaffRole }> = [
    { label: t("settings.staff.role.admin"), value: "ADMIN" },
    { label: t("settings.staff.role.staff"), value: "STAFF" },
    { label: t("settings.staff.role.readOnly"), value: "READ_ONLY" },
  ];

  return (
    <Layout>
      <Layout.Section>
        {actionMessage && (
          <Banner tone="success">
            <p>{actionMessage}</p>
          </Banner>
        )}
        {failureMessage && (
          <Banner tone="critical">
            <p>{failureMessage}</p>
          </Banner>
        )}
        <Banner tone="info">
          <p>{t("settings.staff.intro")}</p>
        </Banner>
      </Layout.Section>
      <Layout.Section variant="oneThird">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {t("settings.staff.inviteTitle")}
            </Text>
            <FormLayout>
              <TextField label={t("settings.staff.email")} type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} autoComplete="off" />
              <TextField label={t("settings.staff.name")} value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoComplete="off" />
              <Select label={t("settings.staff.role.label")} options={roles} value={form.role} onChange={(v) => setForm({ ...form, role: v as StaffRole })} />
              <Button variant="primary" disabled={!form.email} onClick={() => fetcher.submit({ intent: "invite", ...form }, { method: "post" })} loading={fetcher.state !== "idle"}>
                {t("action.invite")}
              </Button>
            </FormLayout>
          </BlockStack>
        </Card>
      </Layout.Section>
      <Layout.Section>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {t("settings.staff.team")}
            </Text>
            {staff.length === 0 && (
              <Text as="p" tone="subdued">
                {t("settings.staff.empty")}
              </Text>
            )}
            {staff.map((m) => (
              <Box key={m.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <BlockStack gap="050">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" fontWeight="semibold">
                        {m.name ?? m.email}
                      </Text>
                      <Badge tone={m.role === "OWNER" || m.role === "ADMIN" ? "success" : undefined}>{m.role}</Badge>
                      {m.disabledAt && <Badge tone="critical">{t("settings.staff.disabled")}</Badge>}
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      {m.email} · {t("settings.staff.invitedOn")} {formatDate(m.invitedAt)}
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200" blockAlign="center">
                    <Select label={t("settings.staff.role.label")} labelHidden options={roles} value={m.role === "OWNER" ? "ADMIN" : m.role} onChange={(v) => fetcher.submit({ intent: "role", id: m.id, role: v }, { method: "post" })} disabled={m.role === "OWNER"} />
                    <Button size="slim" tone="critical" onClick={() => fetcher.submit({ intent: "remove", id: m.id }, { method: "post" })} disabled={m.role === "OWNER"}>
                      {t("action.remove")}
                    </Button>
                  </InlineStack>
                </InlineStack>
              </Box>
            ))}
          </BlockStack>
        </Card>
      </Layout.Section>
    </Layout>
  );
}
