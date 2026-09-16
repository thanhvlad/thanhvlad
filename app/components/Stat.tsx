import { BlockStack, Box, Card, InlineStack, Text } from "@shopify/polaris";

/**
 * One figure with its label.
 *
 * There were two of these, one on the dashboard and one on the order screen,
 * and they had drifted: different type sizes for the same kind of number, and
 * neither used tabular figures, so a column of money jittered as the digits
 * changed. A shared component is the only way a stat on one screen keeps
 * looking like a stat on another.
 */

export type StatTone = "default" | "success" | "warning" | "critical" | "subdued";

const TEXT_TONE: Record<StatTone, "base" | "success" | "caution" | "critical" | "subdued"> = {
  default: "base",
  success: "success",
  warning: "caution",
  critical: "critical",
  subdued: "subdued",
};

export interface StatProps {
  label: string;
  value: string;
  /** Small line under the value: a comparison, a count, a caveat. */
  hint?: string;
  tone?: StatTone;
  /** Render without the Card, for use inside a card that already exists. */
  plain?: boolean;
  /**
   * "large" leads a screen; "medium" sits in a row of figures inside a card
   * that is already about something else. The order screen used the smaller
   * one, the dashboard the larger, and keeping both here is what stops them
   * from drifting apart again.
   */
  size?: "large" | "medium";
}

export function Stat({ label, value, hint, tone = "default", plain = false, size = "large" }: StatProps) {
  const body = (
    <BlockStack gap="100">
      <Text as="p" tone="subdued" variant="bodySm">
        {label}
      </Text>
      {/* `numeric` is what gives tabular figures; without it a column of money
          shifts sideways every time a digit changes width. */}
      <Text
        as="p"
        variant={size === "large" ? "headingLg" : "bodyMd"}
        fontWeight={size === "large" ? undefined : "semibold"}
        numeric
        tone={TEXT_TONE[tone]}
      >
        {value}
      </Text>
      {hint && (
        <Text as="p" tone="subdued" variant="bodySm">
          {hint}
        </Text>
      )}
    </BlockStack>
  );

  if (plain) return body;
  return <Card>{body}</Card>;
}

/**
 * A count that leads somewhere, as used for the order pipeline.
 *
 * A stage with nothing in it is deliberately quieter than one with work in it:
 * every tile looking identical is what made the pipeline read as decoration
 * rather than as the queue it is.
 */
export function CountTile({ label, count, children }: { label: string; count: number; children?: React.ReactNode }) {
  const empty = count === 0;
  return (
    <Box
      padding="300"
      background={empty ? "bg-surface" : "bg-surface-secondary"}
      borderRadius="200"
      borderColor={empty ? "border-disabled" : "border"}
      borderWidth="025"
      minHeight="100%"
    >
      <BlockStack gap="150">
        <InlineStack gap="150" blockAlign="center" wrap={false}>
          {children}
        </InlineStack>
        <Text as="p" variant="headingLg" numeric tone={empty ? "subdued" : "base"}>
          {count}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
      </BlockStack>
    </Box>
  );
}
