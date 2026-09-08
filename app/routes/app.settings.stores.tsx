import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import { Badge, Banner, BlockStack, Box, Button, Card, FormLayout, InlineStack, Layout, Text, TextField } from "@shopify/polaris";
import prisma from "~/db.server";
import { readForm, requireShop } from "~/lib/auth.server";
import { errorMessage } from "~/lib/errors";
import { formatDate } from "~/lib/format";
import { useMessage, useT } from "~/lib/use-t";
import { logActivity } from "~/services/activity.server";
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
  const { shop } = await requireShop(request);
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
    return { ok: false, error: errorMessage(e) };
  }
};

export default function StoresSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const result = fetcher.data as { message?: string; error?: string } | undefined;
  const actionMessage = useMessage(result as Parameters<typeof useMessage>[0]);
  const [name, setName] = useState(data.account?.name ?? "");
  const [code, setCode] = useState("");
  const t = useT();

  return (
    <Layout>
      <Layout.Section>
        {actionMessage && (
          <Banner tone="success">
            <p>{actionMessage}</p>
          </Banner>
        )}
        {result?.error && (
          <Banner tone="critical">
            <p>{result.error}</p>
          </Banner>
        )}
      </Layout.Section>
      <Layout.Section variant="oneThird">
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("settings.stores.account")}
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                {t("settings.stores.accountHelp")}
              </Text>
              <FormLayout>
                <TextField label={t("settings.stores.accountName")} value={name} onChange={setName} autoComplete="off" />
                <Button onClick={() => fetcher.submit({ intent: "rename", name }, { method: "post" })}>{t("action.rename")}</Button>
                <TextField label={t("settings.stores.accountCodeShare")} value={data.joinCode} readOnly autoComplete="off" />
              </FormLayout>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t("settings.stores.linkTitle")}
              </Text>
              <FormLayout>
                <TextField label={t("settings.stores.accountCode")} value={code} onChange={setCode} autoComplete="off" />
                <InlineStack gap="200">
                  <Button variant="primary" disabled={!code.trim()} onClick={() => fetcher.submit({ intent: "join", code }, { method: "post" })}>
                    {t("settings.stores.joinAccount")}
                  </Button>
                  {data.shops.length > 1 && (
                    <Button tone="critical" onClick={() => fetcher.submit({ intent: "leave" }, { method: "post" })}>
                      {t("settings.stores.leaveAccount")}
                    </Button>
                  )}
                </InlineStack>
              </FormLayout>
            </BlockStack>
          </Card>
        </BlockStack>
      </Layout.Section>
      <Layout.Section>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {t("settings.stores.listTitle")} ({data.shops.length})
            </Text>
            {data.shops.map((s) => (
              <Box key={s.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" fontWeight="semibold">
                        {s.name ?? s.domain}
                      </Text>
                      {s.isCurrent && <Badge tone="success">{t("settings.stores.current")}</Badge>}
                      {!s.isActive && <Badge tone="critical">{t("settings.stores.uninstalled")}</Badge>}
                      <Badge>{s.currency}</Badge>
                    </InlineStack>
                    <Text as="p" tone="subdued" variant="bodySm">
                      {s.domain}
                    </Text>
                  </BlockStack>
                  {!s.isCurrent && s.isActive && (
                    <Button size="slim" url={`https://${s.domain}/admin/apps`} external>
                      {t("settings.stores.openStore")}
                    </Button>
                  )}
                </InlineStack>
              </Box>
            ))}
            <Text as="p" tone="subdued" variant="bodySm">
              {t("settings.stores.plan")}: {data.account?.plan ?? "FREE"} · {t("settings.stores.createdOn")} {formatDate(new Date())}
            </Text>
          </BlockStack>
        </Card>
      </Layout.Section>
    </Layout>
  );
}
