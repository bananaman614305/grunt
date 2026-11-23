import type { Completion, ErrorCode, ModelRequest, QuotaWindow, Source } from './source.js';
import { SourceError } from './source.js';
import type { providerQuotaPolicy, SellerQuota } from './quota-policy.js';
import type { MaintenanceEntry } from './maintenance.js';
import { randomUUID } from 'node:crypto';
import { currentDiagnosticContext, sanitizeSafeDiagnosticMetadata, withDiagnosticContext } from './diagnostics.js';
import type { DiagnosticsStore } from './diagnostics.js';
import { currentRoutingWorkload, nextRoutingPerformance, quotaAfterRecovery, mergeRoutingBackoff, nextRoutingBackoff, ROUTING_HISTORY_TTL_MS } from './routing-history.js';
import type { RoutingHistory, RoutingPerformance, RoutingWorkload, RoutingProfile, RoutingBackoff } from './routing-history.js';

// Negative admission evidence may delay discovery, never authorize dispatch.
// Share one bounded window across routing, model-list and recovery metadata reads.
export const AVAILABILITY_NEGATIVE_MS = 30000;

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
  supportsFunctionTools?: boolean;
  quotaWindow?: QuotaWindow;
  quotaPolicy?: NonNullable<ReturnType<typeof providerQuotaPolicy>>;
  scheduledQuotaRefillAt?: number;
  sellerQuota?: SellerQuota;
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
  availabilityQuota?: boolean;
  retryAt?: number;
  availabilityCheckedAt?: number;
  available?: boolean;
  performance?: RoutingPerformance;
  profiles?: Partial<Record<RoutingWorkload, RoutingPerformance>>;
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
  private idleListeners = new Set<(source: string) => void>();
  private diagnostics: DiagnosticsStore | undefined;
  private history: RoutingHistory | undefined;
  private backoffs = new Map<string, RoutingBackoff>();
  private feedback: ((id: string, outcome: 'ok' | ErrorCode, latencyMs?: number) => void) | undefined;
  setDiagnostics(store: DiagnosticsStore) { this.diagnostics = store; }
  // Counts each settled reply for the registry's route feedback.
  setFeedback(feedback: (id: string, outcome: 'ok' | ErrorCode, latencyMs?: number) => void) { this.feedback = feedback; }
  private report(id: string, outcome: 'ok' | ErrorCode, latencyMs?: number) {
    try { this.feedback?.(id, outcome, latencyMs); } catch { /* Feedback must never affect routing. */ }
  }
  constructor(ids: readonly string[], private now: () => number = Date.now, private routes?: { open: (id: string) => boolean; dropped: (id: string) => void }) {
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
    entry.available = true; entry.availabilityCheckedAt = this.now();
    guard.acceptedRevision = entry.revision;
  }
  healthy(id: string) {
    const entry = this.entry(id);
    entry.revision++;
    delete entry.failure; delete entry.retryAt; delete entry.availabilityQuota;
    if (entry.state !== 'ready') entry.state = 'available';
    entry.available = true; entry.availabilityCheckedAt = this.now();
  }
  observedAvailable(id: string) { return this.entry(id).available; }
  private routeOpen(id: string) { return (this.observedAvailable(id) ?? this.entry(id).active > 0) && !!this.routes?.open(id); }
  private notifyClosed(id: string, wasOpen: boolean) {
    if (this.routes && wasOpen && !this.routeOpen(id)) {
      try { this.routes.dropped(id); } catch { return; }
    }
  }
  failed(id: string, code: ErrorCode, retryAfter?: number) {
    const wasOpen = this.routeOpen(id);
    const entry = this.entry(id);
    entry.revision++;
    entry.failure = code;
    delete entry.availabilityQuota;
    delete entry.availabilityCheckedAt; entry.available = false;
    entry.state = code === 'quota' ? 'limited' : code === 'logged_out' || code === 'not_installed' ? 'unavailable' : 'error';
    const seconds = code === 'quota' && typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
    const until = seconds === undefined ? undefined : this.now() + seconds * 1000;
    if (until !== undefined && Number.isFinite(until)) entry.retryAt = until; else delete entry.retryAt;
    this.notifyClosed(id, wasOpen);
  }
  quotaRetryAt(id: string) { return this.observations.get(id)?.retryAt; }
  routingAvailability(id: string, positiveAgeMs: number, negativeAgeMs: number): boolean | undefined {
    const entry = this.entry(id), now = this.now();
    if (entry.availabilityCheckedAt === undefined || entry.available === undefined) return;
    // Honor reset evidence restored from a sibling as well as local metadata.
    // Mixed failures can keep dispatch benched longer than the actual quota;
    // reading quotaUntil here must not shorten that separate dispatch backoff.
    const backoff = this.backoffs.get(id);
    const quotaUntil = Math.max(entry.failure === 'quota' ? entry.retryAt ?? 0 : 0,
      backoff?.code === 'quota' ? backoff.quotaUntil ?? backoff.until : 0);
    // Only evidence older than a known reset expires at that reset. A fresh
    // denial with a zero/no hint still needs a bounded retry window.
    if (!entry.available && entry.availabilityCheckedAt < quotaUntil && quotaUntil <= now) return;
    const age = now - entry.availabilityCheckedAt;
    if (age < 0 || age >= (entry.available ? positiveAgeMs : negativeAgeMs)) return;
    return entry.available;
  }
  // Restored observations are advisory weights and cooldowns, never admission or reply proof.
  async setRoutingHistory(history: RoutingHistory) { this.history = history; await this.refreshRoutingHistory(); }
  async refreshRoutingHistory() {
    if (!this.history) return;
    try {
      const state = await this.history.snapshot(this.now());
      for (const row of state.performance) {
        const entry = this.observations.get(row.source);
        if (!entry) continue;
        this.mergePerformance(entry, row.profile, row.value);
      }
      for (const [id, value] of this.backoffs) if ((this.routingRecoveryAt(id) ?? 0) > value.at) {
        if (value.code === 'quota') this.backoffs.set(id, quotaAfterRecovery(value));
        else this.backoffs.delete(id);
      }
      for (const row of state.backoff) if (this.observations.has(row.source) && (row.value.code === 'quota' || (this.routingRecoveryAt(row.source) ?? 0) <= row.value.at)) {
        const old = this.backoffs.get(row.source);
        const incoming = row.value.code === 'quota' && (this.routingRecoveryAt(row.source) ?? 0) > row.value.at
          ? quotaAfterRecovery(row.value) : row.value;
        this.backoffs.set(row.source, mergeRoutingBackoff(old, incoming));
      }
    } catch { /* Durable observations must not make a source available or break requests. */ }
  }
  async flushRoutingHistory() { await this.history?.flush(); }
  private mergePerformance(entry: Observation, profile: RoutingProfile, value: RoutingPerformance) {
    if (profile === 'all') {
      if (!entry.performance || value.at >= entry.performance.at) entry.performance = value;
    } else {
      entry.profiles ??= {};
      if (!entry.profiles[profile] || value.at >= entry.profiles[profile]!.at) entry.profiles[profile] = value;
    }
  }
  routingRecoveryAt(id: string) { return this.entry(id).performance?.lastSuccessAt; }
  routingBackoff(id: string) { return this.backoffs.get(id); }
  clearRoutingBackoff(id: string) {
    this.backoffs.delete(id);
    void this.history?.clear(id).catch(() => {});
  }
  async failureBackoff(id: string, error: SourceError, seconds: number, adaptive: boolean) {
    const at = this.now();
    const recovered = error.code !== 'quota' && (this.routingRecoveryAt(id) ?? 0) > at;
    const candidate = recovered
      ? { code: error.code, signature: '', streak: 1, at, until: at }
      : nextRoutingBackoff(this.backoffs.get(id), error, seconds, adaptive, at);
    if (!recovered) this.backoffs.set(id, candidate);
    let value = candidate;
    try { if (this.history) value = await this.history.failure(id, error, seconds, adaptive, at); }
    catch { /* Keep the bounded in-memory backoff when private storage is unavailable. */ }
    const current = this.backoffs.get(id), recovery = this.routingRecoveryAt(id) ?? 0;
    if (value.code === 'quota' && recovery > value.at) value = quotaAfterRecovery(value);
    if (value.code !== 'quota' && recovery > value.at) {
      if (current && (current.code === 'quota' || current.at >= recovery)) return current;
      this.backoffs.delete(id);
      return { ...value, until: value.at };
    }
    if (current === candidate || !current) {
      if (value.until <= value.at) this.backoffs.delete(id);
      else this.backoffs.set(id, value);
    } else {
      value = mergeRoutingBackoff(current, value);
      this.backoffs.set(id, value);
    }
    return value;
  }

  routingWeight(id: string, background = false, workload?: RoutingWorkload) {
    const entry = this.entry(id);
    // A short text reply is not evidence for a tool continuation or background
    // job. Keep a cold/sparse matching cohort neutral rather than letting the
    // mixed aggregate bias a new-task draw. Unscoped callers retain the summary.
    const sample = workload ? entry.profiles?.[workload] : entry.performance;
    if (!sample || sample.samples < 2 || this.now() < sample.at || this.now() - sample.at > ROUTING_HISTORY_TTL_MS) return 1;
    // Completed failures cost real time even if the few successful samples are quick.
    const penalty = 1 + sample.failureCostMs / Math.max(250, sample.latencyMs);
    const speed = background ? sample.latencyMs / 10000 : 10000 / sample.latencyMs;
    return Math.max(.05, sample.reliability * Math.max(.25, Math.min(background ? 2 : 4, speed)) / penalty);
  }
  // Switching an established task needs stronger evidence than a new-task draw.
  // Use only the matching workload, never a sparse or stale aggregate profile.
  routingContinuationEstimate(id: string, workload: RoutingWorkload) {
    const sample = this.entry(id).profiles?.[workload], now = this.now();
    if (!sample || sample.samples < 5 || sample.reliability <= 0 || now < sample.at || now - sample.at > 10 * 60 * 1000
      || sample.lastSuccessAt === undefined || now < sample.lastSuccessAt || now - sample.lastSuccessAt > 10 * 60 * 1000) return;
    return { samples: sample.samples, at: sample.at, reliability: sample.reliability,
      expectedMs: (sample.latencyMs + sample.failureCostMs) / sample.reliability };
  }
  private async performance(id: string, success: boolean, latencyMs: number, request: ModelRequest) {
    const entry = this.entry(id), profile = currentRoutingWorkload(request), at = this.now(), revision = entry.revision;
    entry.performance = nextRoutingPerformance(entry.performance, success, latencyMs, at);
    entry.profiles ??= {};
    entry.profiles[profile] = nextRoutingPerformance(entry.profiles[profile], success, latencyMs, at);
    const backoff = this.backoffs.get(id);
    if (success && backoff && at > backoff.at) {
      if (backoff.code === 'quota') this.backoffs.set(id, quotaAfterRecovery(backoff));
      else this.backoffs.delete(id);
    }
    try {
      const rows = await this.history?.record(id, profile, success, latencyMs, at);
      if (entry.revision === revision) for (const row of rows ?? []) this.mergePerformance(entry, row.profile, row.value);
    } catch { /* Local routing stays functional during contention, corruption or disk failure. */ }
  }
  isBusy(id: string) { return (this.observations.get(id)?.active ?? 0) > 0; }
  async waitForIdle(sources: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    if (sources.some(id => !this.isBusy(id))) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.idleListeners.delete(idle);
        signal.removeEventListener('abort', abort);
      };
      const idle = (source: string) => {
        if (!sources.includes(source)) return;
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      this.idleListeners.add(idle);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async available(source: Source, healthCheck = false): Promise<boolean> {
    const entry = this.entry(source.id), revision = entry.revision;
    // Retain only negative metadata. Explicit health checks and all adapter
    // completion guards remain fresh; positive metadata is never reused here.
    // Explicit quota discovery keeps its existing fresh recovery behavior.
    if (!healthCheck && !entry.availabilityQuota && entry.failure !== 'logged_out' && entry.failure !== 'not_installed'
      && this.routingAvailability(source.id, 0, AVAILABILITY_NEGATIVE_MS) === false) return false;
    try {
      const result = await (healthCheck ? source.healthCheck!() : source.available());
      // A reply or explicit recovery observed after this probe started is
      // newer evidence. The caller still receives the actual probe result.
      if (entry.revision === revision) {
        const wasOpen = this.routeOpen(source.id);
        if (!result) {
          if (entry.availabilityQuota) this.healthy(source.id);
          entry.revision++; entry.state = 'unavailable';
        } else if (healthCheck || entry.availabilityQuota) this.healthy(source.id);
        else if (entry.state === 'unknown' || entry.state === 'unavailable') entry.state = 'available';
        entry.available = result; entry.availabilityCheckedAt = this.now();
        this.notifyClosed(source.id, wasOpen);
      }
      return result;
    } catch (error) {
      // Caller/shutdown cancellation says nothing about provider availability.
      if (error instanceof SourceError && error.code === 'cancelled'
        || error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof SourceError && error.code === 'quota') {
        // Preserve a live completion throttle, but accept new evidence after it expires.
        if (entry.revision === revision && (entry.failure !== 'quota' || entry.availabilityQuota || (entry.retryAt ?? 0) <= this.now())) {
          this.failed(source.id, 'quota', error.retryAfter);
          entry.availabilityQuota = true;
          entry.availabilityCheckedAt = this.now();
        }
        return false;
      }
      if (entry.revision === revision) {
        const wasOpen = this.routeOpen(source.id);
        entry.revision++; entry.state = 'unavailable'; entry.available = false;
        // Setup/login recovery has an explicit fresh health-check path. Keep
        // those barriers discoverable immediately after the user repairs them.
        if (failureCode(error) === 'logged_out' || failureCode(error) === 'not_installed') delete entry.availabilityCheckedAt;
        else entry.availabilityCheckedAt = this.now();
        this.notifyClosed(source.id, wasOpen);
      }
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
        entry.available = true; entry.availabilityCheckedAt = this.now();
        delete entry.failure; delete entry.retryAt; delete entry.availabilityQuota;
        if (guard) guard.acceptedRevision = entry.revision;
        this.report(source.id, 'ok', this.now() - started);
        await this.performance(source.id, true, this.now() - started, request);
      }
      return result;
    } catch (error) {
      const code = failureCode(error);
      if (!signal.aborted && code !== 'cancelled' && (!guard || entry.revision === guard.revision)) {
        const retry = error && typeof error === 'object' && 'retryAfter' in error ? error.retryAfter : undefined;
        this.failed(source.id, code, typeof retry === 'number' ? retry : undefined);
        if (guard) guard.acceptedRevision = entry.revision;
        this.report(source.id, code);
        if (code !== 'quota') await this.performance(source.id, false, this.now() - started, request);
      }
      throw error;
    } finally {
      entry.active--;
      if (!entry.active) for (const idle of this.idleListeners) idle(source.id);
    }
  }
  snapshot(options: {
    ids: readonly string[];
    disabled: ReadonlySet<string>;
    pending: ReadonlySet<string>;
    verifying: ReadonlySet<string>;
    preparing: ReadonlySet<string>;
    listed?: (id: string) => boolean;
    retired?: (id: string) => boolean;
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
      else if (options.pending.has(id)) row.state = options.verifying.has(id) ? 'verifying' : 'connecting';
      else if (entry.active) row.state = 'answering';
      else if (cooldown !== undefined && cooldown.until > now) {
        row.state = cooldown.code === 'quota' ? 'limited' : cooldown.until === Infinity ? 'unavailable' : 'error';
        if (Number.isFinite(cooldown.until)) row.retryAt = cooldown.until;
        if (cooldown.code) row.errorCode = cooldown.code;
      } else if (options.preparing.has(id) && entry.state !== 'ready') row.state = 'connecting';
      else if (cooldown !== undefined && (entry.state === 'limited' || entry.state === 'error')) row.state = 'available';
      else if (entry.retryAt !== undefined && entry.retryAt > now) row.retryAt = entry.retryAt;
      else if (entry.retryAt !== undefined && entry.state === 'limited') row.state = 'available';
      if (row.state !== 'disabled' && options.retired?.(id)) row.state = 'unavailable';
      row.detail = `${detail[row.state]}${model ? '; model label comes from the registry, not response attestation' : ''}`;
      return row;
    });
    return { version: 1, updatedAt: now, sources, activeRequests: sources.reduce((total, source) => total + source.active, 0) };
  }
}
