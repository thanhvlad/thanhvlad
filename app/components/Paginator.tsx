import { Pagination, Text, InlineStack } from "@shopify/polaris";
import { useNavigate, useSearchParams } from "@remix-run/react";
import { useT } from "~/lib/use-t";

export function Paginator({ page, pageSize, total }: { page: number; pageSize: number; total: number }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const go = (next: number) => {
    const sp = new URLSearchParams(params);
    sp.set("page", String(next));
    navigate(`?${sp.toString()}`);
  };
  if (total <= pageSize) return null;
  return (
    <InlineStack align="center" gap="400" blockAlign="center">
      <Pagination hasPrevious={page > 1} onPrevious={() => go(page - 1)} hasNext={page < pages} onNext={() => go(page + 1)} />
      {/* This line used to be hardcoded English. It sits under every paginated
          table, so a Vietnamese merchant met it on each of them. */}
      <Text as="span" tone="subdued">
        {t("paginator.summary", { page, pages, total })}
      </Text>
    </InlineStack>
  );
}
