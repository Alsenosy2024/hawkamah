// [MINOR fix / modularity] Shared export-busy/guard/toast wrapper.
//
// SurveyLab, ResponsesCenter and ResponsesPanel each hand-rolled the SAME
// "track a busy key → run an async export → toast on error/success" logic
// around buildXArtifact()/exportDocx() (three independent busy-state shapes:
// SurveyLab's single `busy` string, ResponsesCenter's `exportingId`/
// `exportingAll` pair, ResponsesPanel's `surveyExporting`). This hook owns
// that shared core so there is exactly one implementation.
//
// Deliberately per-key rather than a single boolean: ResponsesCenter/Panel let
// unrelated rows export concurrently today (only the row actually exporting is
// disabled) — collapsing that to one global lock would be a real behavior
// change, not a refactor. `run(key, fn, { exclusive: true })` reproduces
// SurveyLab's stricter "block everything while anything is exporting" gate
// (a no-op re-click while busy) without forcing that stricter behavior on the
// other two callers.
import { useCallback, useState } from 'react';
import { useToast } from '../components/ToastProvider';

export interface UseArtifactExportOptions {
  /** Bilingual prefix shown ahead of the error message (default: "فشل التصدير: " / "Export failed: "). */
  errorPrefix?: { ar: string; en: string };
  /** Message toasted on success (skipped when absent). */
  successMessage?: string;
  /**
   * When true, `run()` is a no-op while ANY key on this hook instance is busy
   * (matches SurveyLab's pre-refactor `guard`). Default false — concurrent,
   * independent keys may run at once (matches ResponsesCenter/Panel's rows).
   */
  exclusive?: boolean;
}

export interface UseArtifactExportApi {
  /** True while `key` specifically is running. */
  isBusy: (key: string) => boolean;
  /** True while ANY key is running (for `exclusive`-style "disable everything" UIs). */
  anyBusy: boolean;
  /** Run `fn` under busy-key `key`; toasts on error, optionally on success. */
  run: (key: string, fn: () => Promise<void>, opts?: UseArtifactExportOptions) => Promise<void>;
}

const DEFAULT_ERROR_PREFIX = { ar: 'فشل التصدير: ', en: 'Export failed: ' };

/** Shared busy-tracking + toast wrapper for artifact export actions. */
export function useArtifactExport(language: 'ar' | 'en' = 'ar'): UseArtifactExportApi {
  const toast = useToast();
  const ar = language === 'ar';
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());

  const isBusy = useCallback((key: string) => busyKeys.has(key), [busyKeys]);
  const anyBusy = busyKeys.size > 0;

  const run = useCallback(async (
    key: string,
    fn: () => Promise<void>,
    opts?: UseArtifactExportOptions,
  ) => {
    if (opts?.exclusive && busyKeys.size > 0) return;
    setBusyKeys(prev => new Set(prev).add(key));
    try {
      await fn();
      if (opts?.successMessage) toast.success(opts.successMessage);
    } catch (e: any) {
      // A user-initiated cancellation (AbortController) is not a failure —
      // surface it neutrally instead of as an error.
      if (e?.message === 'ABORTED') {
        toast.info(ar ? 'تم إلغاء العملية.' : 'Operation cancelled.');
      } else {
        const prefix = opts?.errorPrefix ?? DEFAULT_ERROR_PREFIX;
        toast.error((ar ? prefix.ar : prefix.en) + (e?.message || e));
      }
    } finally {
      setBusyKeys(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  }, [busyKeys, toast, ar]);

  return { isBusy, anyBusy, run };
}
