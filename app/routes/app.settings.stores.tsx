import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Badge, Banner, BlockStack, Box, Button, Card, FormLayout, InlineGrid, InlineStack, Layout, Modal, Text, TextField } from "@shopify/polaris";
import { ClipboardIcon } from "@shopify/polaris-icons";
import { SectionHeader } from "~/components/SectionHeader";
import { useSettingsPageAction } from "~/components/settings-page-action";
import prisma from "~/db.server";
import { readForm, requireShop } from "~/lib/auth.server";
import { actionFailure } from "~/lib/errors";
import { useErrorMessage, useMessage, useT } from "~/lib/use-t";
import { logActivity } from "~/services/activity.server";
import { assertWithinPlan } from "~/services/billing.server";
import { listAccountShops } from "~/services/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop } = await requireShop(request);
  const account = shop.accountId ? await prisma.account.findUnique({ where: { id: shop.accountId } }) : null;
  const shops = await listAccountShops(shop.accountId);
  return {
    current: shop.domain,
    account: account ? { id: account.id, name: account.name, plan: account.plan } : null,
    shops: shops.map((s) => ({ ...s, isCurrent: s.domain === shop.domain })),
    joinCode: account?.id ?? "",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await requireShop(request, { minRole: "ADMIN" });
  const { intent, get } = await readForm(request);
  try {
    switch (intent) {
      case "rename": {
        if (!shop.accountId) return { ok: false, error: "No account" };
        await prisma.account.update({ where: { id: shop.accountId }, data: { name: get("name").trim() || shop.domain } });
        return { ok: true, messageKey: "msg.accountRenamed" };
      }
      case "join": {
        // Move this store under another store's account (share suppliers, pricing rules are per-store).
        const target = await prisma.account.findUnique({ where: { id: get("code").trim() } });
        if (!target) return { ok: false, error: "No account found for that code." };
        if (target.id !== shop.accountId) await assertWithinPlan({ accountId: target.id }, "stores", 1);
        const previous = shop.accountId;
        await prisma.shop.update({ where: { id: shop.id }, data: { accountId: target.id } });
        if (previous && previous !== target.id) {
          const remaining = await prisma.shop.count({ where: { accountId: previous } });
          if (remaining === 0) await prisma.account.delete({ where: { id: previous } }).catch(() => undefined);
        }
        await logActivity(shop.id, { action: "shop.joined_account", message: `Store joined account "${target.name}".` });
        return { ok: true, messageKey: "msg.storeJoinedAccount", messageVars: { name: target.name } };
      }
      case "leave": {
        const account = await prisma.account.create({ data: { name: shop.domain.replace(".myshopify.com", "") } });
        await prisma.shop.update({ where: { id: shop.id }, data: { accountId: account.id } });
        await logActivity(shop.id, { action: "shop.left_account", message: "Store moved to its own account." });
        return { ok: true, messageKey: "msg.storeNowOwnAccount" };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return actionFailure(e);
  }
};

export default function StoresSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const result = fetcher.data as { ok?: boolean; message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const failureMessage = useErrorMessage(result as Parameters<typeof useErrorMessage>[0]);
  const [name, setName] = useState(data.account?.name ?? "");
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState<"join" | "leave" | null>(null);
  const t = useT();
  const busy = fetcher.state !== "idle";
  const busyIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const nameDirty = name.trim() !== (data.account?.name ?? "").trim();
  const planName = data.account?.plan ?? "FREE";

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(data.joinCode);
      shopify.toast.show(t("settings.stores.codeCopied"));
    } catch {
      shopify.toast.show(t("settings.stores.copyFailed"), { isError: true });
    }
  };

  useSettingsPageAction({
    content: t("settings.actions.save"),
    onAction: () => fetcher.submit({ intent: "rename", name }, { method: "post" }),
    loading: busyIntent === "rename",
    disabled: !data.account || !nameDirty || (busy && busyIntent !== "rename"),
  });

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
            <Banner tone="critical" title={t("settings.stores.failed")}>
              <p>{failureMessage}</p>
            </Banner>
          )}
        </Layout.Section>
      )}

      <Layout.AnnotatedSection title={t("settings.stores.account")} description={t("settings.stores.accountHelp")}>
        <Card>
          <FormLayout>
            <TextField label={t("settings.stores.accountName")} value={name} onChange={setName} autoComplete="off" disabled={!data.account} helpText={t("settings.stores.accountName.help")} />
            <TextField
              label={t("settings.stores.accountCodeShare")}
              value={data.joinCode}
              readOnly
              autoComplete="off"
              monospaced
              connectedRight={<Button icon={ClipboardIcon} onClick={copyCode} accessibilityLabel={t("settings.stores.copyCode")} disabled={!data.joinCode} />}
              helpText={t("settings.stores.accountCode.help")}
            />
            <InlineStack gap="200" blockAlign="center">
              <Text as="span" tone="subdued" variant="bodySm">
                {t("settings.stores.plan")}
              </Text>
              <Badge tone={planName === "FREE" ? undefined : "success"}>{planName}</Badge>
            </InlineStack>
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.AnnotatedSection title={t("settings.stores.linkTitle")} description={t("settings.stores.linkDescription")}>
        <Card>
          <FormLayout>
            <TextField label={t("settings.stores.accountCode")} value={code} onChange={setCode} autoComplete="off" monospaced placeholder={t("settings.stores.accountCode.placeholder")} />
            <InlineStack gap="200">
              <Button variant="primary" disabled={!code.trim() || (busy && busyIntent !== "join")} loading={busyIntent === "join"} onClick={() => setConfirm("join")}>
                {t("settings.stores.joinAccount")}
              </Button>
              {data.shops.length > 1 && (
                <Button tone="critical" disabled={busy && busyIntent !== "leave"} loading={busyIntent === "leave"} onClick={() => setConfirm("leave")}>
                  {t("settings.stores.leaveAccount")}
                </Button>
              )}
            </InlineStack>
          </FormLayout>
        </Card>
      </Layout.AnnotatedSection>

      <Layout.Section>
        <BlockStack gap="300">
          <SectionHeader title={t("settings.stores.listTitle")} count={data.shops.length} />
          <InlineGrid columns={{ xs: 1, sm: 2, lg: 3 }} gap="400">
            {data.shops.map((s) => (
              <Card key={s.id} background={s.isCurrent ? "bg-surface-secondary" : undefined}>
                <BlockStack gap="300">
                  <BlockStack gap="100">
                    <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
                      <Text as="h3" variant="headingSm" truncate>
                        {s.name ?? s.domain}
                      </Text>
                      {s.isCurrent ? <Badge tone="success">{t("settings.stores.current")}</Badge> : !s.isActive ? <Badge tone="critical">{t("settings.stores.uninstalled")}</Badge> : <Badge tone="info">{t("settings.stores.connected")}</Badge>}
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm" breakWord>
                      {s.domain}
                    </Text>
                  </BlockStack>
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="100" blockAlign="center">
                      <Text as="span" tone="subdued" variant="bodySm">
                        {t("settings.stores.currency")}
                      </Text>
                      <Badge>{s.currency}</Badge>
                    </InlineStack>
                    {!s.isCurrent && s.isActive && (
                      <Button size="slim" url={`https://${s.domain}/admin/apps`} external>
                        {t("settings.stores.openStore")}
                      </Button>
                    )}
                  </InlineStack>
                </BlockStack>
              </Card>
            ))}
          </InlineGrid>
          <Box>
            <Text as="p" tone="subdued" variant="bodySm">
              {t("settings.stores.listHelp")}
            </Text>
          </Box>
        </BlockStack>
      </Layout.Section>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === "leave" ? t("settings.stores.leaveConfirm.title") : t("settings.stores.joinConfirm.title")}
        primaryAction={{
          content: confirm === "leave" ? t("settings.stores.leaveAccount") : t("settings.stores.joinAccount"),
          destructive: confirm === "leave",
          onAction: () => {
            if (confirm === "leave") fetcher.submit({ intent: "leave" }, { method: "post" });
            if (confirm === "join") fetcher.submit({ intent: "join", code }, { method: "post" });
            setConfirm(null);
          },
        }}
        secondaryActions={[{ content: t("action.cancel"), onAction: () => setConfirm(null) }]}
      >
        <Modal.Section>
          <Text as="p">{confirm === "leave" ? t("settings.stores.leaveConfirm.body") : t("settings.stores.joinConfirm.body", { code: code.trim() })}</Text>
        </Modal.Section>
      </Modal>
    </Layout>
  );
}
