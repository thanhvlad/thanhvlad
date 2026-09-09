import { Text } from "@shopify/polaris";
import type { StatTone } from "~/components/Stat";
import { formatPercent } from "~/lib/format";

/**
 * A margin, and the one opinion the app holds about it.
 *
 * The import list and the import editor both show margins, and they were
 * colouring them differently: the editor's summary called anything under 20%
 * a warning while the list only flinched at a loss. A merchant reading a green
 * column and then an orange stat for the same product has been told two
 * different things. The thresholds live here now, once.
 *
 * Losing money is critical, a thin margin is a caution, everything else is
 * fine. The judgement is the same on both screens; only its loudness differs —
 * a single summary stat can afford to go green, a whole column of green is
 * noise, so `MarginText` leaves a healthy margin in the plain body colour and
 * spends colour only where the merchant needs to look.
 */
export function marginTone(percent: number): StatTone {
  if (!Number.isFinite(percent)) return "subdued";
  if (percent < 0) return "critical";
  if (percent < 20) return "warning";
  return "success";
}

const TEXT_TONE: Record<StatTone, "critical" | "caution" | "success" | "subdued" | undefined> = {
  critical: "critical",
  warning: "caution",
  success: undefined,
  subdued: "subdued",
  default: undefined,
};

/**
 * A margin as a table cell. `numeric` keeps a column of them from jittering as
 * digits change width; `end` is how money and percentages align in a table.
 */
export function MarginText({ value, alignment = "end" }: { value: string | number; alignment?: "start" | "end" }) {
  const percent = typeof value === "string" ? Number(value) : value;
  return (
    <Text as="p" alignment={alignment} numeric tone={TEXT_TONE[marginTone(percent)]}>
      {formatPercent(value)}
    </Text>
  );
}
