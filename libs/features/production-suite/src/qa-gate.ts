import { useEffect, useState } from 'react';
import type { QaReportResponse } from '@asvs/ports';
import { getOrchestrationClient, useWorkspaceSyncStore } from '@asvs/state';

/**
 * Gate 3 · the review page's QA gate state.
 *
 * This module is intentionally tiny and JSX-free: it lives in the `review`
 * route chunk (its imports — `@asvs/state` — are already there for
 * `ReviewArtifactPanel`), while the report *renderer* stays behind
 * `React.lazy`. The approve buttons must be disabled even if the lazy chunk
 * never loads, so the decision cannot depend on it.
 *
 * Fail-closed rules, in priority order:
 * - a present report for the current script version with `verdict: 'fail'`
 *   blocks approval (the server will refuse export with `export_qa_blocked`);
 * - a present report for *another* script version blocks approval too — the
 *   current version has never been QA'd, and approving would launder that;
 * - no server / no report does not block the local review (the server-side
 *   `POST /exports` gate is the hard gate and refuses `export_qa_missing`).
 */

export type QaGateStatus = 'loading' | 'unavailable' | 'empty' | 'ready' | 'error';

export interface QaGate {
  status: QaGateStatus;
  envelope: QaReportResponse | null;
  error: string | null;
  /** Present report does not cover the current script version. */
  stale: boolean;
  /** QA verdict is `fail`: approval and export are refused. */
  blocked: boolean;
  /** Blockers counted in the report, for the header summary. */
  blockerCount: number;
  privacyBlockerCount: number;
  /** Human sentence explaining why approval is disabled, or null. */
  reason: string | null;
}

const INITIAL: QaGate = {
  status: 'loading',
  envelope: null,
  error: null,
  stale: false,
  blocked: false,
  blockerCount: 0,
  privacyBlockerCount: 0,
  reason: null,
};

export function useQaGate(videoId: string | undefined, scriptVersion: number): QaGate {
  const syncConfig = useWorkspaceSyncStore((state) => state.config);
  const [gate, setGate] = useState<QaGate>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    if (!syncConfig.enabled || !videoId) {
      setGate({ ...INITIAL, status: 'unavailable' });
      return;
    }
    setGate((previous) => ({ ...previous, status: 'loading', error: null }));
    void (async () => {
      try {
        const client = await getOrchestrationClient(syncConfig.baseUrl);
        if (!(await client.isReachable())) {
          if (!cancelled) setGate({ ...INITIAL, status: 'unavailable' });
          return;
        }
        const envelope = await client.getLatestQaReport(syncConfig.workspaceId, videoId);
        if (cancelled) return;
        if (!envelope) {
          setGate({ ...INITIAL, status: 'empty' });
          return;
        }
        setGate(deriveQaGate(envelope, scriptVersion));
      } catch (caught) {
        if (cancelled) return;
        // Fail closed: the server answered, but not with a report we can trust
        // (409 `qa_report_tampered`, a parse failure, or a dropped connection).
        // Approving on an unverifiable report would launder it.
        setGate({
          ...INITIAL,
          status: 'error',
          blocked: true,
          error: caught instanceof Error ? caught.message : String(caught),
          reason: '服务端 QA 报告无法校验（可能被篡改或已损坏）；批准与导出已禁用，请重新运行 QA。',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncConfig.enabled, syncConfig.baseUrl, syncConfig.workspaceId, videoId, scriptVersion]);

  return gate;
}

export function deriveQaGate(envelope: QaReportResponse, scriptVersion: number): QaGate {
  const { report } = envelope;
  const stale = report.subject.scriptVersion !== scriptVersion;
  const blocked = report.verdict === 'fail';
  const blockerCount = report.summary.blockerCount;
  const privacyBlockerCount = report.summary.privacyBlockerCount;
  const reason = stale
    ? `最近一份独立 QA 报告对应 v${report.subject.scriptVersion}，当前工程是 v${scriptVersion}；需要重新生产以覆盖当前版本。`
    : blocked
      ? privacyBlockerCount > 0
        ? `服务端独立 QA 已阻断本次运行：${blockerCount} 项阻断，其中 ${privacyBlockerCount} 项为 AC-07 隐私命中。`
        : `服务端独立 QA 已阻断本次运行：${blockerCount} 项阻断需要修复后重新运行。`
      : null;
  return {
    status: 'ready',
    envelope,
    error: null,
    stale,
    blocked,
    blockerCount,
    privacyBlockerCount,
    reason,
  };
}
