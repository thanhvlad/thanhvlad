import { Link } from "@remix-run/react";
import { Badge, InlineStack, Text } from "@shopify/polaris";

/**
 * The heading row of a card: title, an optional count, an optional link on the
 * right. Every card that has a heading uses this, so "View all" sits in the
 * same place on every screen and a count reads the same way everywhere.
 */
export interface SectionHeaderProps {
  title: string;
  count?: number;
  action?: { content: string; to: string };
}

export function SectionHeader({ title, count, action }: SectionHeaderProps) {
  return (
    <InlineStack align="space-between" blockAlign="center" gap="200">
      <InlineStack gap="200" blockAlign="center">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>
        {typeof count === "number" && <Badge>{String(count)}</Badge>}
      </InlineStack>
      {action && <Link to={action.to}>{action.content}</Link>}
    </InlineStack>
  );
}
