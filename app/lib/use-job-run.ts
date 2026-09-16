import { useEffect, useRef, useState } from "react";

/**
 * Track the background job a bulk action just started.
 *
 * A fetcher's `data` outlives the job it announced. Reading it during render to
 * set state means that as soon as `JobProgress` finishes and clears the id, the
 * next render puts it straight back: the progress banner can never be dismissed,
 * the poller restarts, and any side effect passed as `onStart` (clearing the
 * table selection, say) fires again over whatever the merchant has done since.
 *
 * So the id we have already acted on is remembered in a ref, and the state is
 * assigned in an effect rather than mid-render.
 */
export function useJobRun(data: unknown, onStart?: () => void) {
  const [jobRunId, setJobRunId] = useState<string | null>(null);
  const handledRef = useRef<string | null>(null);
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;

  const announced =
    data && typeof data === "object" && "jobRunId" in data && typeof (data as { jobRunId?: unknown }).jobRunId === "string"
      ? (data as { jobRunId: string }).jobRunId
      : null;

  useEffect(() => {
    if (!announced || handledRef.current === announced) return;
    handledRef.current = announced;
    setJobRunId(announced);
    onStartRef.current?.();
  }, [announced]);

  return { jobRunId, clearJobRun: () => setJobRunId(null) };
}
