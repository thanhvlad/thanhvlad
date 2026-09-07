import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import type { StaffRole } from "@prisma/client";
import { Badge, Banner, BlockStack, Box, Button, Card, FormLayout, InlineStack, Layout, Select, Text, TextField } from "@shopify/polaris";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate } from "~/lib/format";
import { ROLE_PERMISSIONS, inviteStaff, listStaff, removeStaff, updateStaffRole } from "~/services/staff.server";

const ROLES: Array<{ label: string; value: StaffRole }> = [
  { label: "Admin — everything except staff management", value: "ADMIN" },
  { label: "Staff — import, map and place orders", value: "STAFF" },
  { label: "Read only", value: "READ_ONLY" },
];

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
        return { ok: true, message: `${get("email")} invited.` };
      case "role":
        await updateStaffRole(shop.id, get("id"), get("role") as StaffRole);
        return { ok: true, message: "Role updated." };
      case "remove":
        await removeStaff(shop.id, get("id"));
        return { ok: true, message: "Member removed." };
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
};

export default function StaffSettings() {
  const { staff } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const [form, setForm] = useState({ email: "", name: "", role: "STAFF" as StaffRole });

  return (
    <Layout>
      <Layout.Section>
        {result?.message && (
          <Banner tone="success">
            <p>{result.message}</p>
          </Banner>
        )}
        {result?.error && (
          <Banner tone="critical">
            <p>{result.error}</p>
          </Banner>
        )}
        <Banner tone="info">
          <p>Staff members sign in through Shopify as usual (add them as staff in Shopify admin). Roles here control what they can do inside the app across all your connected stores.</p>
        </Banner>
      </Layout.Section>
      <Layout.Section variant="oneThird">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Invite a member
            </Text>
            <FormLayout>
              <TextField label="Email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} autoComplete="off" />
              <TextField label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} autoComplete="off" />
              <Select label="Role" options={ROLES} value={form.role} onChange={(v) => setForm({ ...form, role: v as StaffRole })} />
              <Button variant="primary" disabled={!form.email} onClick={() => fetcher.submit({ intent: "invite", ...form }, { method: "post" })} loading={fetcher.state !== "idle"}>
                Invite
              </Button>
            </FormLayout>
          </BlockStack>
        </Card>
      </Layout.Section>
      <Layout.Section>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Team
            </Text>
            {staff.length === 0 && (
              <Text as="p" tone="subdued">
                Only the store owner has access.
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
                      {m.disabledAt && <Badge tone="critical">Disabled</Badge>}
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      {m.email} · invited {formatDate(m.invitedAt)}
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200" blockAlign="center">
                    <Select label="Role" labelHidden options={ROLES} value={m.role === "OWNER" ? "ADMIN" : m.role} onChange={(v) => fetcher.submit({ intent: "role", id: m.id, role: v }, { method: "post" })} disabled={m.role === "OWNER"} />
                    <Button size="slim" tone="critical" onClick={() => fetcher.submit({ intent: "remove", id: m.id }, { method: "post" })} disabled={m.role === "OWNER"}>
                      Remove
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
