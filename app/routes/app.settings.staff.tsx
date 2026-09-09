import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import type { StaffRole } from "@prisma/client";
import { Badge, Banner, BlockStack, Box, Button, Card, FormLayout, IndexTable, Layout, List, Modal, Select, Text, TextField } from "@shopify/polaris";
import { EmptyScreen } from "~/components/EmptyScreen";
import { SectionHeader } from "~/components/SectionHeader";
import { useSettingsPageAction } from "~/components/settings-page-action";
import { readForm, requireShop } from "~/lib/auth.server";
import { actionFailure } from "~/lib/errors";
import { formatDate } from "~/lib/format";
import type { I18nKey } from "~/lib/i18n";
import { useErrorMessage, useLocale, useMessage, useT } from "~/lib/use-t";
import { ROLE_PERMISSIONS, inviteStaff, listStaff, removeStaff, updateStaffRole } from "~/services/staff.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const staff = shop.accountId ? await listStaff(shop.accountId) : [];
  return { staff, permissions: ROLE_PERMISSIONS };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request, { minRole: "OWNER" });
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function StaffSettings() {
  const { staff, permissions } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(result as Parameters<typeof useErrorMessage>[0]);
  const [form, setForm] = useState({ email: "", name: "", role: "STAFF" as StaffRole });
  const [removing, setRemoving] = useState<{ id: string; email: string } | null>(null);
  const t = useT();
  const locale = useLocale();
  const dateLocale = locale === "vi" ? "vi-VN" : "en-US";
  const busy = fetcher.state !== "idle";
  const busyIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const busyId = busy ? String(fetcher.formData?.get("id") ?? "") : "";
  const emailValid = EMAIL.test(form.email.trim());

  const roles: Array<{ label: string; value: StaffRole }> = [
    { label: t("settings.staff.role.admin"), value: "ADMIN" },
    { label: t("settings.staff.role.staff"), value: "STAFF" },
    { label: t("settings.staff.role.readOnly"), value: "READ_ONLY" },
  ];
  const roleOptions: Array<{ label: string; value: StaffRole }> = [
    { label: t("settings.staff.roleName.ADMIN"), value: "ADMIN" },
    { label: t("settings.staff.roleName.STAFF"), value: "STAFF" },
    { label: t("settings.staff.roleName.READ_ONLY"), value: "READ_ONLY" },
  ];

  const invite = () => {
    if (!emailValid) return;
    fetcher.submit({ intent: "invite", email: form.email.trim(), name: form.name.trim(), role: form.role }, { method: "post" });
  };

  useSettingsPageAction({ content: t("settings.staff.inviteAction"), onAction: invite, loading: busyIntent === "invite", disabled: !emailValid || (busy && busyIntent !== "invite") });

  const permissionSummary = (role: StaffRole) => {
    const p = permissions[role];
    const granted = [
      p.canEdit ? t("settings.staff.permission.edit") : null,
      p.canOrder ? t("settings.staff.permission.order") : null,
      p.canManageSettings ? t("settings.staff.permission.settings") : null,
      p.canManageStaff ? t("settings.staff.permission.staff") : null,
    ].filter(Boolean);
    return granted.length ? granted.join(" · ") : t("settings.staff.permission.viewOnly");
  };

  return (
    <Layout>
      {(actionMessage || failureMessage) && (
        <Layout.Section>
          {actionMessage && result?.ok && (
            <Banner tone="success">
              <p>{actionMessage}</p>
            </Banner>
          )}
          {failureMessage && (
            <Banner tone="critical" title={t("settings.staff.failed")}>
              <p>{failureMessage}</p>
            </Banner>
          )}
        </Layout.Section>
      )}

      <Layout.AnnotatedSection title={t("settings.staff.inviteTitle")} description={t("settings.staff.intro")}>
        <Card>
          <FormLayout>
            <FormLayout.Group>
              <TextField
                label={t("settings.staff.email")}
                type="email"
                value={form.email}
                onChange={(v) => setForm({ ...form, email: v })}
                autoComplete="off"
                requiredIndicator
                error={form.email && !emailValid ? t("settings.staff.emailInvalid") : undefined}
              />
              <TextField label={t("settings.staff.name")} value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoComplete="off" />
            </FormLayout.Group>
            <Select label={t("settings.staff.role.label")} options={roles} value={form.role} onChange={(v) => setForm({ ...form, role: v as StaffRole })} helpText={permissionSummary(form.role)} />
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.staff.roles.title")} description={t("settings.staff.roles.description")}>
        <Card>
          <List>
            {(["OWNER", "ADMIN", "STAFF", "READ_ONLY"] as StaffRole[]).map((role) => (
              <List.Item key={role}>
                <Text as="span" fontWeight="semibold">
                  {t(`settings.staff.roleName.${role}` as I18nKey)}
                </Text>{" "}
                <Text as="span" tone="subdued">
                  — {permissionSummary(role)}
                </Text>
              </List.Item>
            ))}
          </List>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.Section>
        <Card padding="0">
          <BlockStack gap="0">
            <Box padding="400">
              <SectionHeader title={t("settings.staff.team")} count={staff.length} />
            </Box>
            {staff.length === 0 ? (
              <EmptyScreen compact heading={t("settings.staff.empty")} body={t("settings.staff.emptyBody")} />
            ) : (
              <IndexTable
                resourceName={{ singular: t("settings.staff.resource.singular"), plural: t("settings.staff.resource.plural") }}
                itemCount={staff.length}
                selectable={false}
                headings={[
                  { title: t("settings.staff.email") },
                  { title: t("settings.staff.name") },
                  { title: t("settings.staff.role.label") },
                  { title: t("common.status") },
                  { title: t("settings.staff.invited") },
                  { title: t("settings.staff.actions"), alignment: "end" },
                ]}
              >
                {staff.map((m, index) => {
                  const isOwner = m.role === "OWNER";
                  const rowBusy = busyId === m.id;
                  return (
                    <IndexTable.Row id={m.id} key={m.id} position={index}>
                      <IndexTable.Cell>
                        <Text as="span" fontWeight="semibold">
                          {m.email}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{m.name ?? <Text as="span" tone="subdued">—</Text>}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {isOwner ? (
                          <Badge tone="success">{t("settings.staff.roleName.OWNER")}</Badge>
                        ) : (
                          <Select
                            label={t("settings.staff.role.label")}
                            labelHidden
                            options={roleOptions}
                            value={m.role}
                            onChange={(v) => fetcher.submit({ intent: "role", id: m.id, role: v }, { method: "post" })}
                            disabled={busy}
                          />
                        )}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {m.disabledAt ? <Badge tone="critical">{t("settings.staff.disabled")}</Badge> : <Badge tone="success">{t("settings.staff.active")}</Badge>}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" tone="subdued" variant="bodySm">
                          {formatDate(m.invitedAt, dateLocale)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Box>
                          <Button
                            size="slim"
                            tone="critical"
                            onClick={() => setRemoving({ id: m.id, email: m.email })}
                            disabled={isOwner || (busy && !rowBusy)}
                            loading={rowBusy && busyIntent === "remove"}
                          >
                            {t("action.remove")}
                          </Button>
                        </Box>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            )}
          </BlockStack>
        </Card>
      </Layout.Section>

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t("settings.staff.removeConfirm.title")}
        primaryAction={{
          content: t("action.remove"),
          destructive: true,
          onAction: () => {
            if (removing) fetcher.submit({ intent: "remove", id: removing.id }, { method: "post" });
            setRemoving(null);
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setRemoving(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t("settings.staff.removeConfirm.body", { email: removing?.email ?? "" })}</Text>
        </Modal.Section>
      </Modal>
    </Layout>
  );
}
