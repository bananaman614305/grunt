export type ErrorCode = 'not_installed' | 'logged_out' | 'quota' | 'timeout' | 'upstream' | 'refused' | 'cancelled';
import { providerQuotaPolicy, scheduledQuotaRefill } from './quota-policy.js';
import type { SellerQuota } from './quota-policy.js';
import { randomUUID } from 'node:crypto';
import { currentDiagnosticContext, withDiagnosticContext } from './diagnostics.js';
import type { DiagnosticsStore, SafeDiagnosticMetadata, DiagnosticContext } from './diagnostics.js';
export class SourceError extends Error {
  constructor(public code: ErrorCode, message: string, public retryAfter?: number, public output?: string, public diagnostics?: SafeDiagnosticMetadata) { super(message); }
}
export interface Message { role: string; content: string; tool_call_id?: string; tool_calls?: ToolCall[] }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type Tool = { type: 'function'; function: { name: string; description?: string; parameters: unknown } } | { type: string; [key: string]: unknown };
export interface ModelRequest {
  model: string;
  messages: Message[];
  userMessages?: string[];
  tools: Tool[];
  cwd: string;
  stream: boolean;
  maxTokens?: number;
  imageInput?: boolean;
  handoffPrompt?: string;
  // Local worker routing metadata is never decoded from a model API request.
  worker?: { id: string; onSource: (source: string) => void; onWait?: () => void };
}
export interface Completion { text: string; calls?: ToolCall[]; inputTokens?: number; outputTokens?: number; diagnostics?: SafeDiagnosticMetadata }
// Names the adapter that produced each completion; setup checks it against the requested adapter.
export const answeredBy = new WeakMap<Completion, string>();
export interface QuotaWindow { startedAt: number; resetAt: number }
export interface Source {
  id: string;
  supportsFunctionTools?: boolean;
  // A source that calls output() when it first produces output gets the
  // first-output deadline. Other sources keep only their own timeouts.
  reportsOutput?: boolean;
  available(): Promise<boolean>;
  quotaWindow?(): QuotaWindow | undefined;
  sellerQuota?(): SellerQuota | undefined;
  healthCheck?(): Promise<boolean>;
  complete(request: ModelRequest, signal: AbortSignal, output?: () => void): Promise<Completion>;
  // Called after a failed request (not a cancellation). Must not block.
  failed?(error: SourceError): void;
  close?(): Promise<void>;
}
// A request that carries Pi's function tools expects tool calls back, so Pi
// keeps the agent loop. Automatic selection skips sources that run their own
// tools instead (OpenCode). A source the caller names explicitly stays eligible.
export const needsFunctionTools = (request: ModelRequest) => request.tools.some(tool => tool.type === 'function');
export const toolCapable = (source: Source) => source.supportsFunctionTools === true;
export const NO_TOOL_SOURCE = 'No tool-capable adapter is available for a request with function tools; finish setup or retry after quota resets';
// A source that has not produced first output by this time counts as failed.
export const FIRST_OUTPUT_MS = 60000;
const cutoffs = new WeakSet<SourceError>();
export class Sources {
  private router: StickyRouter | undefined;
  private workerRouter: StickyRouter | undefined;
  private observation: SourceStatus;
  private checking = new Set<string>();
  private maintenance: (() => Record<string, MaintenanceEntry>) | undefined;
  private diagnostics: DiagnosticsStore | undefined;
  // Adapters whose background setup has not finished yet.
  readonly preparing = new Set<string>();
  // Foreground signups must not probe or dispatch incomplete sources. Routine
  // background checks remain metadata and do not interrupt already-bound work.
  readonly pending = new Set<string>();
  // An exact-ID setup probe may run without admitting that source to the pool.
  readonly verifying = new Set<string>();
  // Foreground approval metadata contains adapter IDs only, never handoff URLs.
  readonly approvals = new Set<string>();
  constructor(public readonly sources: Source[], private routing?: RoutingOptions, private disabledModels: ReadonlySet<string> = new Set(), private firstOutputMs = FIRST_OUTPUT_MS) {
    if ((!sources.length && !disabledModels.size) || new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Configure distinct grunt sources');
    this.observation = new SourceStatus(sources.map(source => source.id), routing?.now);
    if (routing) this.router = this.createRouter(routing);
  }
  setWorkerRegistry(registry: RoutingOptions['registry'], localOptIns?: RoutingOptions['localOptIns']) {
    // Mixed source configurations preserve their normal fixed route chain.
    // Only subworkers use this secondary router over the same observations.
    if (!this.router) this.workerRouter = this.createRouter({ registry, ...(localOptIns ? { localOptIns } : {}) });
  }
  private get registeredRouter() { return this.router ?? this.workerRouter; }
  private createRouter(routing: RoutingOptions) {
    return new StickyRouter(this.sources, { ...routing, pending: this.pending, disabled: this.disabledModels, observation: this.observation, attempt: this.attempt,
      observe: (source, reason, skipped) => {
        const context = currentDiagnosticContext();
        if (context) this.diagnostics?.record({ version: 1, id: randomUUID(), at: Date.now(), requestId: context.requestId, kind: context.kind,
          type: skipped ? 'route.skip' : 'route.selection', source, reason, ...(skipped ? { outcome: 'skipped' } : {}) });
      } });
  }
  // One routed call to one source, with the first-output deadline. A failure
  // (not a cancellation) is logged and reported to the source.
  private attempt = async (source: Source, request: ModelRequest, signal: AbortSignal): Promise<Completion> => {
    const timed: Source = { id: source.id, available: () => source.available(), complete: (r, s) => this.firstOutput(source, r, s) };
    try { return await this.observation.complete(timed, request, signal); }
    catch (error) {
      if (!signal.aborted && error instanceof SourceError && error.code !== 'cancelled') {
        // The fixed chain below logs its own failures.
        if (this.router) console.error(`grunt source: ${source.id} failed (${error.code}) for model ${this.safeModel(request.model)}`);
        try { source.failed?.(error); } catch { /* Diagnostics must never affect routing. */ }
      }
      throw error;
    }
  };
  private firstOutput(source: Source, request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    if (!source.reportsOutput) return source.complete(request, caller);
    const deadline = new AbortController();
    const signal = AbortSignal.any([caller, deadline.signal]);
    let timer: NodeJS.Timeout | undefined;
    const work = source.complete(request, signal, () => { clearTimeout(timer); timer = undefined; });
    const cutoff = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new SourceError('timeout', `${source.id} produced no output within ${this.firstOutputMs / 1000} seconds`);
        cutoffs.add(error); deadline.abort(error); reject(error);
      }, this.firstOutputMs);
    });
    // Do not wait for a hung source to clean up; it settles on its own.
    work.catch(() => {});
    return Promise.race([work, cutoff]).finally(() => clearTimeout(timer));
  }
  private safeModel(model: string) { return ['grunt', 'milo', ...this.sources.map(source => source.id)].includes(model) ? model : 'grunt'; }
  healthy(id: string) { this.registeredRouter?.healthy(id); this.observation.healthy(id); }
  setDiagnostics(store: DiagnosticsStore) { this.diagnostics = store; this.observation.setDiagnostics(store); }
  diagnosticStore() { return this.diagnostics; }
  setMaintenance(reader: () => Record<string, MaintenanceEntry>) { this.maintenance = reader; }
  status(): PoolSnapshot {
    const snapshot = this.observation.snapshot({ ids: this.sources.map(source => source.id), disabled: this.disabledModels,
      pending: this.pending, verifying: this.verifying, approvals: this.approvals, preparing: this.preparing,
      ...(this.router ? { listed: (id: string) => this.router!.listed(id), cooldown: (id: string) => this.router!.cooldown(id) } : {}),
      model: id => {
        const adapter = this.routing?.registry().adapters.find(adapter => adapter.id === id);
        // A rotation is a configured set, not an assertion about which model
        // generated the latest answer. Never inspect private adapter configs.
        const model = adapter?.models && adapter.models.length > 1 ? 'Free model rotation' : adapter?.models?.[0] ?? adapter?.model;
        return model && /^[a-zA-Z0-9][a-zA-Z0-9._:/+ -]{0,159}$/.test(model) ? model : undefined;
      }
    });
    const maintenance = this.maintenance?.();
    for (const row of snapshot.sources) {
      const source = this.sources.find(candidate => candidate.id === row.id);
      if (source) row.supportsFunctionTools = toolCapable(source);
      const policy = providerQuotaPolicy(row.id);
      if (policy) row.quotaPolicy = policy;
      const refillAt = scheduledQuotaRefill(row.id, snapshot.updatedAt);
      if (refillAt !== undefined) row.scheduledQuotaRefillAt = refillAt;
      const window = source?.quotaWindow?.();
      if (window) row.quotaWindow = { ...window };
      const advertised = source?.sellerQuota?.();
      if (advertised) row.sellerQuota = { ...advertised };
      const entry = maintenance?.[row.id];
      if (entry) row.maintenance = { ...entry };
    }
    return snapshot;
  }
  // Maintenance uses the configured source directly. It cannot silently pass
  // because a different provider answered, nor start provisioning or repair.
  async check(id: string, caller: AbortSignal): Promise<MaintenanceResult> {
    return withDiagnosticContext({ requestId: randomUUID(), kind: 'maintenance', ...(this.diagnostics ? { sink: this.diagnostics } : {}) }, () => this.checkSource(id, caller));
  }
  private async checkSource(id: string, caller: AbortSignal): Promise<MaintenanceResult> {
    caller.throwIfAborted();
    const now = () => (this.routing?.now ?? Date.now)();
    const source = this.sources.find(source => source.id === id);
    if (!source) return { outcome: 'deferred', code: 'not_installed' };
    const eligible = (): MaintenanceResult | undefined => {
      if (this.disabledModels.has(id) || this.router && !this.router.listed(id)) return { outcome: 'deferred', code: 'not_installed' };
      if (this.pending.has(id) || this.verifying.has(id) || this.approvals.has(id)) return { outcome: 'deferred', code: 'foreground' };
      const snapshot = this.status(), state = snapshot.sources.find(source => source.id === id)!;
      if (state.active || this.checking.has(id)) return { outcome: 'deferred', code: 'busy' };
      if (state.retryAt !== undefined && state.retryAt > now()) return { outcome: 'deferred', code: state.errorCode ?? 'quota', retryAt: state.retryAt };
      if (state.state === 'ready' && !state.errorCode && state.lastSuccessAt !== undefined && state.lastSuccessAt > now() - 24 * 60 * 60 * 1000) {
        return { outcome: 'passed', evidence: 'reply', lastSuccessAt: state.lastSuccessAt };
      }
      if (snapshot.activeRequests) return { outcome: 'deferred', code: 'busy' };
    };
    const previous = eligible();
    if (previous) return previous;
    this.checking.add(id);
    let cwd: string | undefined;
    let guard: ObservationGuard | undefined;
    const newerEvidence = (): MaintenanceResult | undefined => {
      if (!guard || !this.observation.changed(id, guard)) return;
      const state = this.status().sources.find(source => source.id === id)!;
      if (state.retryAt !== undefined && state.retryAt > now()) return { outcome: 'deferred', code: state.errorCode ?? 'quota', retryAt: state.retryAt };
      if (state.state === 'ready' && !state.errorCode && state.lastSuccessAt !== undefined && state.lastSuccessAt > now() - 24 * 60 * 60 * 1000) {
        return { outcome: 'passed', evidence: 'reply', lastSuccessAt: state.lastSuccessAt };
      }
      return { outcome: 'deferred', code: state.errorCode ?? 'busy' };
    };
    const signal = AbortSignal.any([caller, AbortSignal.timeout(MAINTENANCE_CHECK_TIMEOUT)]);
    try {
      if (id === 'clixad') {
        // Clixad's explicit ask path invokes wallet operations which can claim
        // a daily streak reward. Idle maintenance is restricted to its bounded
        // read-only installation/receipt/public-model projection instead.
        guard = this.observation.guard(id);
        const available = await source.available();
        signal.throwIfAborted();
        const newer = newerEvidence();
        if (newer) return newer;
        if (!available) throw new SourceError('not_installed', 'Clixad read-only metadata is unavailable');
        this.observation.metadata(id, guard);
        return { outcome: 'passed', evidence: 'metadata' };
      }
      cwd = await mkdtemp(join(tmpdir(), 'grunt-maintenance-'));
      signal.throwIfAborted();
      // A request or foreground setup may have started during directory IO.
      this.checking.delete(id);
      const changed = eligible();
      this.checking.add(id);
      if (changed) return changed;
      const guarded: Source = { id, available: () => source.available(), complete: async (request, signal) => {
        const reply = await source.complete(request, signal);
        signal.throwIfAborted();
        if (!reply.text.trim()) throw new SourceError('upstream', 'Maintenance received no reply');
        return reply;
      } };
      guard = this.observation.guard(id);
      await this.observation.complete(guarded, { model: id, cwd, messages: [{ role: 'user', content: 'Say hello in one short sentence.' }], tools: [], stream: false, maxTokens: 1024 }, signal, guard);
      signal.throwIfAborted();
      const newer = newerEvidence();
      if (newer) return newer;
      this.registeredRouter?.verified(id);
      return { outcome: 'passed', evidence: 'reply', lastSuccessAt: now() };
    } catch (error) {
      caller.throwIfAborted();
      const newer = newerEvidence();
      if (newer) return newer;
      const failure = signal.aborted ? new SourceError('timeout', 'Maintenance request timed out')
        : error instanceof SourceError ? error : new SourceError('upstream', 'Maintenance request failed');
      if (failure.code === 'cancelled') return { outcome: 'deferred', code: 'cancelled' };
      const retryAfter = failure.code === 'quota' ? (typeof failure.retryAfter === 'number' && Number.isFinite(failure.retryAfter) && failure.retryAfter >= 0 ? failure.retryAfter : 3600) : undefined;
      this.observation.failed(id, failure.code, retryAfter);
      const retryAt = retryAfter === undefined ? undefined : now() + retryAfter * 1000;
      return { outcome: 'failed', code: failure.code, ...(id === 'clixad' ? { evidence: 'metadata' } : {}), ...(retryAt !== undefined && Number.isFinite(retryAt) ? { retryAt } : {}) };
    } finally {
      this.checking.delete(id);
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  }
  async models() {
    const available = await Promise.all(this.sources.map(async s => {
      if (this.pending.has(s.id) || this.router && !this.router.listed(s.id) || !await this.observation.available(s)) return null;
      if (this.registeredRouter?.needsHealthCheck(s.id) && s.healthCheck && await this.observation.available(s, true).catch(() => false)) this.healthy(s.id);
      return s.id;
    }));
    return ['grunt', ...available.filter((id): id is string => id !== null)];
  }
  // When no source can answer, start background recovery so the next request has one.
  setRecovery(recover: () => void) { this.recover = recover; }
  private recover: (() => void) | undefined;
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    const parent = currentDiagnosticContext();
    const context: DiagnosticContext = { requestId: parent?.requestId ?? randomUUID(), kind: !request.worker && this.verifying.has(request.model) ? 'setup' : parent?.kind ?? 'user', ...(this.diagnostics ? { sink: this.diagnostics } : {}) };
    return withDiagnosticContext(context, async () => {
      const started = Date.now(), startedMono = performance.now(), base = { version: 1 as const, requestId: context.requestId, kind: context.kind };
      if (!parent?.requestRecorded) this.diagnostics?.record({ ...base, id: randomUUID(), at: started, type: 'request.start' });
      try {
        const result = await this.route(request, signal);
        if (!parent?.requestRecorded) this.diagnostics?.record({ ...base, id: randomUUID(), at: Date.now(), type: 'request.finish', outcome: signal.aborted ? 'cancelled' : 'passed', durationMs: Math.max(0, performance.now() - startedMono),
          ...(answeredBy.get(result) ? { source: answeredBy.get(result)! } : {}),
          ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }), ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }) });
        return result;
      } catch (error) {
        if (parent?.requestRecorded) parent.errorCode = signal.aborted ? 'cancelled' : error instanceof SourceError ? error.code : 'upstream';
        if (!parent?.requestRecorded) this.diagnostics?.record({ ...base, id: randomUUID(), at: Date.now(), type: 'request.finish', outcome: signal.aborted ? 'cancelled' : 'failed', durationMs: Math.max(0, performance.now() - startedMono),
          errorCode: signal.aborted ? 'cancelled' : error instanceof SourceError ? error.code : 'upstream' });
        if (!request.worker && error instanceof SourceError && (error.code === 'quota' || error.code === 'not_installed' || error.code === 'logged_out')) this.recover?.();
        throw error;
      }
    });
  }
  private async route(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    signal.throwIfAborted();
    if (request.worker) {
      const router = this.registeredRouter;
      if (!router) throw new SourceError('not_installed', 'Subworkers need the registered free model pool');
      return router.complete({ ...request, model: 'grunt' }, signal);
    }
    if (this.disabledModels.has(request.model)) throw new SourceError('refused', `${request.model} routing is disabled`);
    if (this.pending.has(request.model)) {
      if (!this.verifying.has(request.model)) throw new SourceError('not_installed', `${request.model} setup is still in progress`);
      const source = this.sources.find(source => source.id === request.model);
      if (!source) throw new SourceError('not_installed', `No source for model ${this.safeModel(request.model)}`);
      if (this.router && !this.router.listed(source.id)) throw new SourceError('not_installed', `${request.model} is not in the current provider registry`);
      if (this.router && !this.router.supportsInput(source.id, request.imageInput)) throw new SourceError('refused', `${request.model} does not support this input modality`);
      // A setup probe is one exact-source call, never sticky failover or a
      // retry of a provider refusal. The source retains every normal guard.
      const completion = await this.observation.complete(source, request, signal);
      signal.throwIfAborted();
      this.registeredRouter?.verified(source.id);
      answeredBy.set(completion, source.id);
      return completion;
    }
    if (this.router) return this.router.complete(request, signal);
    const known = this.sources.some(s => s.id === request.model);
    // Older harness configurations may still request the former model name.
    const automatic = request.model === 'grunt' || request.model === 'milo' || !known;
    if (automatic && !['grunt', 'milo'].includes(request.model)) console.error('grunt model mapping: unrecognized model -> grunt');
    const toolsRequired = automatic && needsFunctionTools(request);
    const candidates = automatic ? this.sources.filter(s => !toolsRequired || toolCapable(s)) : this.sources.filter(s => s.id === request.model);
    let last = toolsRequired ? new SourceError('not_installed', NO_TOOL_SOURCE) : new SourceError('not_installed', `No source for model ${this.safeModel(request.model)}`);
    let attempted = false;
    for (const source of candidates) {
      signal.throwIfAborted();
      if (this.pending.has(source.id)) continue;
      const context = currentDiagnosticContext();
      if (context) this.diagnostics?.record({ version: 1, id: randomUUID(), at: Date.now(), requestId: context.requestId, kind: context.kind, type: 'route.selection', source: source.id,
        ...(!automatic ? { reason: 'explicit' as const } : attempted ? { reason: 'fallback' as const } : {}) });
      attempted = true;
      let completion: Completion;
      try { completion = await this.attempt(source, request, signal); }
      catch (error) {
        if (signal.aborted || (error instanceof SourceError && error.code === 'cancelled')) {
          console.error(`grunt source: ${source.id} cancelled for model ${this.safeModel(request.model)}`);
          signal.throwIfAborted();
          throw error;
        }
        last = error instanceof SourceError ? error : new SourceError('upstream', `Source ${source.id} failed`);
        console.error(`grunt source: ${source.id} failed (${last.code}) for model ${this.safeModel(request.model)}`);
        // Only dots and OpenCode deadlines and first-output deadlines fall through; caller cancellation stops above.
        if (last.code === 'timeout' && source.id !== 'dots' && source.id !== 'opencode' && !cutoffs.has(last)) throw last;
        continue;
      }
      console.error(`grunt source: ${source.id} answered model ${this.safeModel(request.model)}`);
      answeredBy.set(completion, source.id);
      return completion;
    }
    throw last;
  }
  async close() { await Promise.allSettled(this.sources.map(s => s.close?.())); }
}
export class Gateway implements Source {
  id = 'gateway';
  readonly supportsFunctionTools = true;
  private url: string;
  constructor(url: string, private key: string, private fetcher: typeof fetch = fetch) {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid GRUNT_GATEWAY_URL');
    this.url = `${url.replace(/\/$/, '')}/chat/completions`;
  }
  async available() { return true; }
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    if (request.tools.some(t => t.type !== 'function')) throw new SourceError('upstream', 'Gateway Chat Completions cannot forward native Responses tools; use the local app source');
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: 'grunt', messages: request.messages, tools: request.tools.length ? request.tools : undefined, stream: false, max_tokens: request.maxTokens ?? 4096 })
      });
    } catch { signal.throwIfAborted(); throw new SourceError('upstream', 'grunt gateway is unavailable'); }
    if (!response.ok) throw new SourceError(response.status === 401 || response.status === 403 ? 'logged_out' : response.status === 429 ? 'quota' : 'upstream', `grunt gateway returned HTTP ${response.status}`);
    const body = await response.json() as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const message = body.choices?.[0]?.message;
    if (!message || (typeof message.content !== 'string' && !message.tool_calls?.length)) throw new SourceError('upstream', 'grunt gateway returned an invalid completion');
    return { text: message.content ?? '', ...(message.tool_calls ? { calls: message.tool_calls } : {}),
      ...(body.usage?.prompt_tokens === undefined ? {} : { inputTokens: body.usage.prompt_tokens }), ...(body.usage?.completion_tokens === undefined ? {} : { outputTokens: body.usage.completion_tokens }) };
  }
}
import { StickyRouter } from './routing.js';
import type { RoutingOptions } from './routing.js';
import { SourceStatus } from './source-status.js';
import type { ObservationGuard, PoolSnapshot } from './source-status.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MaintenanceEntry, MaintenanceResult } from './maintenance.js';
import { MAINTENANCE_CHECK_TIMEOUT } from './maintenance.js';
