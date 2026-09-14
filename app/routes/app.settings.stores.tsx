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
import { formatDate } from "~/lib/format";
import type { I18nVars } from "~/lib/i18n";
import * as billingStrings from "~/lib/i18n-modules/billing";
import { useErrorMessage, useLocale, useMessage, useT } from "~/lib/use-t";
import { createAccountInvite, joinAccountWithInvite, leaveAccount, listAccountShops } from "~/services/shop.server";

type BillingKey = keyof typeof billingStrings.en;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, role } = await requireShop(request);
  const account = shop.accountId ? await prisma.account.findUnique({ where: { id: shop.accountId } }) : null;
  const shops = await listAccountShops(shop.accountId);
  const isOwner = role === "OWNER";
  // The invite is shown to the owner only, and only while it still works. The
  // raw account id used to be shown to everyone as a permanent join code.
  const inviteLive = Boolean(account?.joinCode && account.joinCodeExpiresAt && account.joinCodeExpiresAt > new Date());
  return {
    current: shop.domain,
    account: account ? { id: account.id, name: account.name, plan: account.plan } : null,
    shops: shops.map((s) => ({ ...s, isCurrent: s.domain === shop.domain })),
    isOwner,
    invite: isOwner && inviteLive ? { code: account!.joinCode!, expiresAt: account!.joinCodeExpiresAt!.toISOString() } : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, role } = await requireShop(request, { minRole: "ADMIN" });
  const { intent, get } = await readForm(request);
  // Linking decides which plan a store runs on and who pays for it, so it is
  // the owner's call on both sides: the owner of the account creates the code,
  // and the owner of the joining store redeems it.
  const ownerOnly = { ok: false as const, error: billingStrings.en["billing.stores.ownerOnly"], errorKey: "billing.stores.ownerOnly" };
  try {
    switch (intent) {
      case "rename": {
        if (!shop.accountId) return { ok: false, error: "No account" };
        await prisma.account.update({ where: { id: shop.accountId }, data: { name: get("name").trim() || shop.domain } });
        return { ok: true, messageKey: "msg.accountRenamed" };
      }
      case "createInvite": {
        if (role !== "OWNER") return ownerOnly;
        if (!shop.accountId) return { ok: false, error: "No account" };
        await createAccountInvite(shop.accountId);
        return { ok: true, messageKey: "billing.stores.inviteCreated", message: billingStrings.en["billing.stores.inviteCreated"] };
      }
      case "join": {
        // Move this store under another store's account (share suppliers, pricing rules are per-store).
        if (role !== "OWNER") return ownerOnly;
        const target = await joinAccountWithInvite(shop, get("code"));
        return { ok: true, messageKey: "msg.storeJoinedAccount", messageVars: { name: target.name } };
      }
      case "leave": {
        if (role !== "OWNER") return ownerOnly;
        await leaveAccount(shop);
        return { ok: true, messageKey: "msg.storeNowOwnAccount" };
      }
      default:
        return { ok: false, error: "Unknown action" };
    }
  } catch (e) {
    return actionFailure(e);
  }
};

/**
 * Strings from the billing module. app/lib/i18n.ts spreads each module into the
 * typed dictionary by hand and does not include this one yet, so until it does
 * these are looked up here, with the same English fallback and placeholders.
 */
function useBillingT() {
  const locale = useLocale();
  const bt = (key: BillingKey, vars?: I18nVars) => {
    const raw = (locale === "vi" ? billingStrings.vi[key] : undefined) ?? billingStrings.en[key];
    return vars ? raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : raw;
  };
  const has = (key: string | null | undefined): key is BillingKey => Boolean(key && key in billingStrings.en);
  return { bt, has };
}

type ActionResult = { ok?: boolean; message?: string; messageKey?: string; messageVars?: I18nVars; error?: string; errorKey?: string; errorVars?: I18nVars } | undefined;

export default function StoresSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const result = fetcher.data as ActionResult;
  const { bt, has } = useBillingT();
  const locale = useLocale();
  const genericMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const genericFailure = useErrorMessage(result as Parameters<typeof useErrorMessage>[0]);
  const actionMessage = has(result?.messageKey) ? bt(result.messageKey, result.messageVars) : genericMessage;
  const failureMessage = !result?.ok && has(result?.errorKey) ? bt(result.errorKey, result.errorVars) : genericFailure;
  const [name, setName] = useState(data.account?.name ?? "");
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState<"join" | "leave" | null>(null);
  const t = useT();
  const busy = fetcher.state !== "idle";
  const busyIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";
  const nameDirty = name.trim() !== (data.account?.name ?? "").trim();
  const planName = data.account?.plan ?? "FREE";
  const dateLocale = locale === "vi" ? "vi-VN" : "en-US";

  const copyCode = async () => {
    if (!data.invite) return;
    try {
      await navigator.clipboard.writeText(data.invite.code);
      shopify.toast.show(bt("billing.stores.inviteCopied"));
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

  const createInvite = () => fetcher.submit({ intent: "createInvite" }, { method: "post" });

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
            {!data.isOwner ? (
              <Text as="p" tone="subdued">
                {bt("billing.stores.ownerOnly")}
              </Text>
            ) : data.invite ? (
              <BlockStack gap="200">
                <TextField
                  label={bt("billing.stores.inviteLabel")}
                  value={data.invite.code}
                  readOnly
                  autoComplete="off"
                  monospaced
                  connectedRight={<Button icon={ClipboardIcon} onClick={copyCode} accessibilityLabel={bt("billing.stores.inviteCopy")} />}
                  helpText={bt("billing.stores.inviteHelp", { date: formatDate(data.invite.expiresAt, dateLocale) })}
                />
                <InlineStack>
                  <Button onClick={createInvite} loading={busyIntent === "createInvite"} disabled={!data.account || (busy && busyIntent !== "createInvite")}>
                    {bt("billing.stores.inviteReplace")}
                  </Button>
                </InlineStack>
              </BlockStack>
            ) : (
              <BlockStack gap="200">
                <Text as="p" tone="subdued">
                  {bt("billing.stores.inviteNone")}
                </Text>
                <InlineStack>
                  <Button onClick={createInvite} loading={busyIntent === "createInvite"} disabled={!data.account || (busy && busyIntent !== "createInvite")}>
                    {bt("billing.stores.inviteCreate")}
                  </Button>
                </InlineStack>
              </BlockStack>
            )}
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
            <TextField
              label={bt("billing.stores.inviteLabel")}
              value={code}
              onChange={setCode}
              autoComplete="off"
              monospaced
              disabled={!data.isOwner}
              placeholder={t("settings.stores.accountCode.placeholder")}
              helpText={data.isOwner ? undefined : bt("billing.stores.ownerOnly")}
            />
            <InlineStack gap="200">
              <Button variant="primary" disabled={!data.isOwner || !code.trim() || (busy && busyIntent !== "join")} loading={busyIntent === "join"} onClick={() => setConfirm("join")}>
                {t("settings.stores.joinAccount")}
              </Button>
              {data.shops.length > 1 && (
                <Button tone="critical" disabled={!data.isOwner || (busy && busyIntent !== "leave")} loading={busyIntent === "leave"} onClick={() => setConfirm("leave")}>
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
