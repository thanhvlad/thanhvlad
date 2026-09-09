import { useEffect, useRef } from "react";
import { useFetcher, useRevalidator } from "@remix-run/react";
import { Banner, BlockStack, ProgressBar, Text } from "@shopify/polaris";
import type { I18nKey, Translator } from "~/lib/i18n";
import { useT } from "~/lib/use-t";

interface JobSnapshot {
  id: string;
  type: string;
  status: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  error: string | null;
}

/**
 * Polls /api/jobs/:id every 2s while a bulk job runs and revalidates the page
 * when it finishes, so tables refresh without a manual reload.
 */
export function JobProgress({ jobRunId, title, onDone }: { jobRunId: string | null | undefined; title?: string; onDone?: () => void }) {
  const t = useT();
  const fetcher = useFetcher<JobSnapshot>();
  const revalidator = useRevalidator();
  // `fetcher.data` outlives the job it describes, so every read is scoped to the
  // id currently being watched — otherwise a finished previous job makes the new
  // one look finished before its first response arrives.
  const job = fetcher.data && fetcher.data.id === jobRunId ? fetcher.data : undefined;
  const finished = Boolean(job && ["SUCCEEDED", "FAILED", "CANCELED"].includes(job.status));

  // `useFetcher` hands back a new object whenever its data changes, so the
  // interval closure would read a frozen `fetcher.data` and poll forever. The
  // stop condition lives in a ref that the render keeps current instead.
  const doneRef = useRef(false);
  doneRef.current = finished;

  const loadRef = useRef(fetcher.load);
  loadRef.current = fetcher.load;

  useEffect(() => {
    if (!jobRunId) return;
    doneRef.current = false;
    let cancelled = false;
    const load = () => {
      if (!cancelled) loadRef.current(`/api/jobs/${jobRunId}`);
    };
    load();
    const timer = setInterval(() => {
      if (doneRef.current) {
        clearInterval(timer);
        return;
      }
      load();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobRunId]);

  useEffect(() => {
    if (finished) {
      revalidator.revalidate();
      onDone?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  if (!jobRunId || !job) return null;
  const percent = job.total > 0 ? Math.round((job.processed / job.total) * 100) : job.status === "SUCCEEDED" ? 100 : 0;

  return (
    <Banner tone={job.status === "FAILED" || job.failed > 0 ? "warning" : finished ? "success" : "info"} title={title ?? jobTitle(job.type, t)}>
      <BlockStack gap="200">
        <ProgressBar progress={percent} size="small" />
        <Text as="p">
          {job.processed}/{job.total} {t("job.processed")} · {job.succeeded} {t("job.succeeded")} · {job.failed} {t("job.failed")}
          {job.error ? ` · ${job.error}` : ""}
        </Text>
      </BlockStack>
    </Banner>
  );
}

/** The job's own type is the fallback for a job with no translated name. */
function jobTitle(type: string, t: Translator) {
  return t(`job.${type}` as I18nKey) ?? type;
}
