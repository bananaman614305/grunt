import type { Completion, ErrorCode, ModelRequest, Source } from './source.js';
import type { MaintenanceEntry } from './maintenance.js';
import { randomUUID } from 'node:crypto';
import { currentDiagnosticContext, sanitizeSafeDiagnosticMetadata, withDiagnosticContext } from './diagnostics.js';
import type { DiagnosticsStore } from './diagnostics.js';

export type SourceState = 'unknown' | 'available' | 'ready' | 'answering' | 'connecting' | 'verifying' | 'approval' | 'limited' | 'error' | 'disabled' | 'unavailable';
export interface SourceSnapshot {
  id: string;
  state: SourceState;
  model?: string;
  modelKind?: 'registry';
  active: number;
  lastReplyMs?: number;
  lastSuccessAt?: number;
  retryAt?: number;
  errorCode?: ErrorCode;
  detail?: string;
  maintenance?: MaintenanceEntry;
}
export interface PoolSnapshot { version: 1; updatedAt: number; sources: SourceSnapshot[]; activeRequests: number }
interface Observation {
  state: 'unknown' | 'available' | 'ready' | 'limited' | 'error' | 'unavailable';
  active: number;
  revision: number;
  lastReplyMs?: number;
  lastSuccessAt?: number;
  failure?: ErrorCode;
  retryAt?: number;
}
export interface ObservationGuard { revision: number; acceptedRevision?: number }
const codes = new Set<ErrorCode>(['not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled']);
const failureCode = (error: unknown): ErrorCode => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && codes.has(code as ErrorCode) ? code as ErrorCode : 'upstream';
};
const detail: Record<SourceState, string> = {
  unknown: 'No runtime activity observed yet', available: 'Configured; awaiting a verified reply', ready: 'A successful reply was observed',
  answering: 'Request in progress', connecting: 'Setup or a background check is in progress', verifying: 'Setup is verifying this source', approval: 'Needs foreground verification',
  limited: 'Free quota or rate limit reached', error: 'Source failed; another source may answer', disabled: 'Routing is disabled',
  unavailable: 'Not currently available; setup may be needed'
};

// This observer records only events the runtime already performs. Reading a
// snapshot never calls a provider, reads credentials, or stores request content.
export class SourceStatus {
  private observations = new Map<string, Observation>();
  private diagnostics: DiagnosticsStore | undefined;
  setDiagnostics(store: DiagnosticsStore) { this.diagnostics = store; }
  constructor(ids: readonly string[], private now: () => number = Date.now) {
    for (const id of ids) this.observations.set(id, { state: 'unknown', active: 0, revision: 0 });
  }
  private entry(id: string) {
    let entry = this.observations.get(id);
    if (!entry) { entry = { state: 'unknown', active: 0, revision: 0 }; this.observations.set(id, entry); }
    return entry;
  }
  guard(id: string): ObservationGuard { return { revision: this.entry(id).revision }; }
  changed(id: string, guard: ObservationGuard) { return this.entry(id).revision !== (guard.acceptedRevision ?? guard.revision); }
  metadata(id: string, guard: ObservationGuard) {
    const entry = this.entry(id);
    if (this.changed(id, guard) || entry.failure) return;
    // Read-only catalog/local access is weaker than a generated reply. It must
    // not recover failures or turn an old successful response into fresh proof.
    entry.revision++;
    entry.state = 'available';
    guard.acceptedRevision = entry.revision;
  }
  healthy(id: string) {
    const entry = this.entry(id);
    entry.revision++;
    delete entry.failure; delete entry.retryAt;
    if (entry.state !== 'ready') entry.state = 'available';
  }
  failed(id: string, code: ErrorCode, retryAfter?: number) {
    const entry = this.entry(id);
    entry.revision++;
    entry.failure = code;
    entry.state = code === 'quota' ? 'limited' : code === 'logged_out' || code === 'not_installed' ? 'unavailable' : 'error';
    const seconds = code === 'quota' && typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
    const until = seconds === undefined ? undefined : this.now() + seconds * 1000;
    if (until !== undefined && Number.isFinite(until)) entry.retryAt = until; else delete entry.retryAt;
  }
  quotaRetryAt(id: string) { return this.observations.get(id)?.retryAt; }
  async available(source: Source, healthCheck = false): Promise<boolean> {
    const entry = this.entry(source.id), revision = entry.revision;
    try {
      const result = await (healthCheck ? source.healthCheck!() : source.available());
      // A reply or explicit recovery observed after this probe started is
      // newer evidence. The caller still receives the actual probe result.
      if (entry.revision === revision) {
        if (!result) { entry.revision++; entry.state = 'unavailable'; }
        else if (healthCheck) this.healthy(source.id);
        else if (entry.state === 'unknown' || entry.state === 'unavailable') entry.state = 'available';
      }
      return result;
    } catch (error) {
      if (entry.revision === revision) { entry.revision++; entry.state = 'unavailable'; }
      throw error;
    }
  }
  async complete(source: Source, request: ModelRequest, signal: AbortSignal, guard?: ObservationGuard): Promise<Completion> {
    if (!this.diagnostics) return this.observedComplete(source, request, signal, guard);
    const parent = currentDiagnosticContext() ?? { requestId: randomUUID(), kind: 'diagnostic' as const };
    const attemptId = randomUUID(), started = this.now(), startedMono = performance.now();
    const base = { version: 1 as const, requestId: parent.requestId, kind: parent.kind, attemptId, source: source.id };
    this.diagnostics.record({ ...base, id: randomUUID(), at: started, type: 'attempt.start' });
    return withDiagnosticContext({ ...parent, attemptId, sink: this.diagnostics! }, async () => {
      try {
        const result = await this.observedComplete(source, request, signal, guard);
        this.diagnostics!.record({ ...sanitizeSafeDiagnosticMetadata(result.diagnostics), ...base, id: randomUUID(), at: this.now(), type: 'attempt.finish',
          outcome: signal.aborted ? 'cancelled' : 'passed', durationMs: Math.max(0, performance.now() - startedMono),
          ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
          ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }) });
        return result;
      } catch (error) {
        const value = error && typeof error === 'object' ? error as { diagnostics?: object; retryAfter?: unknown } : {};
        this.diagnostics!.record({ ...sanitizeSafeDiagnosticMetadata(value.diagnostics), ...base, id: randomUUID(), at: this.now(), type: 'attempt.finish',
          outcome: signal.aborted ? 'cancelled' : 'failed', errorCode: signal.aborted ? 'cancelled' : failureCode(error),
          durationMs: Math.max(0, performance.now() - startedMono), ...(typeof value.retryAfter === 'number' ? { retryAfterSeconds: value.retryAfter } : {}) });
        throw error;
      }
    });
  }
  private async observedComplete(source: Source, request: ModelRequest, signal: AbortSignal, guard?: ObservationGuard): Promise<Completion> {
    const entry = this.entry(source.id), started = this.now();
    entry.active++;
    try {
      const result = await source.complete(request, signal);
      // A provider may finish after the caller cancelled. That is not evidence
      // of an admitted successful response, and must not resurrect readiness.
      if (!signal.aborted && (!guard || entry.revision === guard.revision)) {
        entry.revision++;
        entry.state = 'ready'; entry.lastSuccessAt = this.now(); entry.lastReplyMs = Math.max(0, this.now() - started);
        delete entry.failure; delete entry.retryAt;
        if (guard) guard.acceptedRevision = entry.revision;
      }
      return result;
    } catch (error) {
      const code = failureCode(error);
      if (!signal.aborted && code !== 'cancelled' && (!guard || entry.revision === guard.revision)) {
        const retry = error && typeof error === 'object' && 'retryAfter' in error ? error.retryAfter : undefined;
        this.failed(source.id, code, typeof retry === 'number' ? retry : undefined);
        if (guard) guard.acceptedRevision = entry.revision;
      }
      throw error;
    } finally { entry.active--; }
  }
  snapshot(options: {
    ids: readonly string[];
    disabled: ReadonlySet<string>;
    pending: ReadonlySet<string>;
    verifying: ReadonlySet<string>;
    approvals: ReadonlySet<string>;
    preparing: ReadonlySet<string>;
    listed?: (id: string) => boolean;
    cooldown?: (id: string) => { until: number; code?: ErrorCode } | undefined;
    model?: (id: string) => string | undefined;
  }): PoolSnapshot {
    const now = this.now();
    const sources = [...new Set([...options.ids, ...options.disabled])].map((id): SourceSnapshot => {
      const entry = this.entry(id), model = options.model?.(id);
      const row: SourceSnapshot = { id, state: entry.state, active: entry.active,
        ...(model ? { model, modelKind: 'registry' } : {}), ...(entry.failure ? { errorCode: entry.failure } : {}), ...(entry.lastReplyMs !== undefined ? { lastReplyMs: entry.lastReplyMs } : {}),
        ...(entry.lastSuccessAt !== undefined ? { lastSuccessAt: entry.lastSuccessAt } : {}) };
      const cooldown = options.cooldown?.(id);
      if (options.disabled.has(id) || options.listed && !options.listed(id)) row.state = 'disabled';
      else if (options.pending.has(id)) row.state = options.verifying.has(id) ? 'verifying' : options.approvals.has(id) ? 'approval' : 'connecting';
      else if (entry.active) row.state = 'answering';
      else if (cooldown !== undefined && cooldown.until > now) {
        row.state = cooldown.code === 'quota' ? 'limited' : cooldown.until === Infinity ? 'unavailable' : 'error';
        if (Number.isFinite(cooldown.until)) row.retryAt = cooldown.until;
      } else if (options.preparing.has(id) && entry.state !== 'ready') row.state = 'connecting';
      else if (cooldown !== undefined && (entry.state === 'limited' || entry.state === 'error')) row.state = 'available';
      else if (entry.retryAt !== undefined && entry.retryAt > now) row.retryAt = entry.retryAt;
      else if (entry.retryAt !== undefined && entry.state === 'limited') row.state = 'available';
      row.detail = `${detail[row.state]}${model ? '; model label comes from the registry, not response attestation' : ''}`;
      return row;
    });
    return { version: 1, updatedAt: now, sources, activeRequests: sources.reduce((total, source) => total + source.active, 0) };
  }
}
