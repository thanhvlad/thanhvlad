import { Box, Button, Card, EmptyState, Text } from "@shopify/polaris";

/**
 * The one empty state.
 *
 * A screen with nothing in it is a screen that has to explain the next move,
 * and the app had eight different ways of doing that, from a Polaris
 * EmptyState to a line of grey text reading "nothing right now". This is the
 * only one now: a heading that names the situation, one sentence on what to
 * do, and the single button that does it.
 */
/** The one illustration every empty state in the app already used. */
const EMPTY_IMAGE = "https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png";

export interface EmptyScreenProps {
  heading: string;
  body: string;
  action?: { content: string; url?: string; onAction?: () => void };
  /** A smaller, in-card variant for a section that is empty inside a busy screen. */
  compact?: boolean;
}

export function EmptyScreen({ heading, body, action, compact = false }: EmptyScreenProps) {
  if (compact) {
    return (
      <Box paddingBlock="400" paddingInline="200">
        <Text as="p" fontWeight="semibold">
          {heading}
        </Text>
        <Text as="p" tone="subdued">
          {body}
        </Text>
        {action && (
          <Box paddingBlockStart="200">
            <Button url={action.url} onClick={action.onAction} size="slim">
              {action.content}
            </Button>
          </Box>
        )}
      </Box>
    );
  }
  return (
    <Card>
      <EmptyState heading={heading} action={action} image={EMPTY_IMAGE}>
        <p>{body}</p>
      </EmptyState>
    </Card>
  );
}
