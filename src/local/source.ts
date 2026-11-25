export type ErrorCode = 'not_installed' | 'logged_out' | 'quota' | 'timeout' | 'upstream' | 'refused' | 'cancelled';
import { knownAdapters } from '../registry.js';
import { providerQuotaPolicy, scheduledQuotaRefill } from './quota-policy.js';
import type { SellerQuota } from './quota-policy.js';
import { randomUUID } from 'node:crypto';
import { currentDiagnosticContext, diagnosticFinishReasons, withDiagnosticContext } from './diagnostics.js';
import type { DiagnosticsStore, SafeDiagnosticMetadata, DiagnosticContext } from './diagnostics.js';
import type { RoutingHistory } from './routing-history.js';
import { localRequestRefusal } from './routing-history.js';
import { MetadataFlights } from './metadata-flight.js';
export class SourceError extends Error {
  replay?: 'safe' | 'unsafe';
  constructor(public code: ErrorCode, message: string, public retryAfter?: number, public output?: string, public diagnostics?: SafeDiagnosticMetadata) { super(message); }
}
export function canReplay(error: SourceError) {
  return error.code !== 'cancelled' && !(error instanceof RequestError)
    && (error.replay === 'safe' || error.replay === undefined && error.code !== 'timeout');
}
export function replayTimeout(message: string, safe: boolean) {
  const error = new SourceError('timeout', message);
  error.replay = safe ? 'safe' : 'unsafe';
  return error;
}
export function preventReplay(error: unknown, message: string): SourceError {
  const failure = error instanceof SourceError ? error : new SourceError('upstream', message);
  failure.replay = 'unsafe';
  return failure;
}
// The request's own shape (tools, schema, tool conversation) was refused before any provider was reached.
// failureReason 'request_*' marks it so routing never counts it as provider health.
export const requestRefusal = (message: string, failureReason: 'request_tools' | 'request_tool_schema' = 'request_tools') =>
  new SourceError('refused', message, undefined, undefined, { failureReason });
// The client sent something grunt cannot translate. This is a request problem,
// not a source failure: it is raised before routing, so no source is tried and
// none gets a cooldown. The API answers it with HTTP 400.
export class RequestError extends SourceError {
  constructor(message: string) { super('refused', message); }
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
  // The local client reviewed the entire request for public-only providers.
  publicContext?: true;
}
export function lengthLimited(reason: unknown) {
  return reason === 'length' || reason === 'max_tokens';
}

// An unfinished tool call cannot be executed. Keep visible text and measured usage.
export function truncatedCompletion(content: unknown, usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }): Completion {
  const input = usage?.prompt_tokens, output = usage?.completion_tokens;
  return withEnding({ text: typeof content === 'string' ? content : '', finishReason: 'length',
    ...(typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? { inputTokens: input } : {}),
    ...(typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 ? { outputTokens: output } : {}) }, completionEnding('length', usage, false));
}

// Arguments of a call the client will execute must be one JSON object. Blank arguments are the
// conventional empty call and become "{}", as the Messages encoding has always done.
function usableArguments(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim() === '' ? '{}' : value;
  try { const parsed: unknown = JSON.parse(text); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? text : undefined; }
  catch { return undefined; }
}
// The one gate every source reply passes before routing or a client sees it. An unparseable call is
// never returned as complete: the client would store it, and the unusable arguments then make every
// later request of that conversation fail validation. A reply that hit its output budget keeps its
// text as a length-limited completion, whatever finish_reason the provider claimed. Anything else is
// an invalid sample, so routing records a short bench and the task continues on another source.
export function guardToolCalls(result: Completion, request: Pick<ModelRequest, 'maxTokens'>): Completion {
  if (!result.calls?.length) {
    // A reply that says it ended in a tool call but carries none cannot be executed, and the client would treat the
    // text as a finished answer. Only the provider's own finish_reason decides; text is never inspected or changed.
    const finish = endingOf(result)?.finish, claimed = finish === 'tool_calls' || finish === 'function_call';
    if (!claimed || result.finishReason === 'length') return result;
    const budget = request.maxTokens;
    if (budget !== undefined && result.outputTokens !== undefined && result.outputTokens >= budget) return withEnding({ ...result, finishReason: 'length' }, { ...endingOf(result), finish: 'length' });
    throw new SourceError('upstream', 'Source ended in a tool call but returned none', undefined, undefined, { failureReason: 'response_tools', httpStatus: 200 });
  }
  const fixed = result.calls.map(call => usableArguments(call?.function?.arguments));
  if (fixed.every(text => text !== undefined)) {
    result.calls.forEach((call, index) => { call.function.arguments = fixed[index]!; });
    return result;
  }
  const budget = request.maxTokens;
  if (result.finishReason === 'length' || budget !== undefined && result.outputTokens !== undefined && result.outputTokens >= budget) {
    const { calls: _dropped, ...kept } = result;
    return withEnding({ ...kept, finishReason: 'length' }, { ...endingOf(result), finish: 'length', toolCalls: false });
  }
  throw new SourceError('upstream', 'Source returned a tool call with unparseable arguments', undefined, undefined, { failureReason: 'response_tools', httpStatus: 200 });
}

// Content-free facts about how a reply ended, for local diagnostics only. `finish` is the provider's finish_reason
// mapped to a fixed set (anything unrecognised is 'other', never the raw string); `toolCalls` says whether the reply
// carried parsed calls. Nothing here is sent to a client, the registry or the fleet collector.
export interface CompletionEnding { finish?: typeof diagnosticFinishReasons[number]; toolCalls?: boolean; reasoningTokens?: number }
// Kept beside the reply, not on it, so the Completion shape every client and test sees is unchanged.
const endings = new WeakMap<Completion, CompletionEnding>();
export function withEnding<T extends Completion>(reply: T, ending: CompletionEnding): T { endings.set(reply, ending); return reply; }
export const endingOf = (reply: Completion): CompletionEnding | undefined => endings.get(reply);
export function completionEnding(finish: unknown, usage: unknown, toolCalls: boolean): CompletionEnding {
  const known = typeof finish === 'string' ? (diagnosticFinishReasons as readonly string[]).includes(finish) ? finish as typeof diagnosticFinishReasons[number]
    : finish === 'max_tokens' ? 'length' : 'other' : finish === undefined || finish === null ? undefined : 'other';
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const u = record(usage), details = record(u.completion_tokens_details ?? u.output_tokens_details), reasoning = details.reasoning_tokens;
  return { ...(known ? { finish: known } : {}), toolCalls,
    ...(typeof reasoning === 'number' && Number.isSafeInteger(reasoning) && reasoning >= 0 ? { reasoningTokens: reasoning } : {}) };
}
export interface Completion { servedModel?: string; free?: boolean; text: string; calls?: ToolCall[]; finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call'; inputTokens?: number; outputTokens?: number; diagnostics?: SafeDiagnosticMetadata }
// Names the adapter that produced each completion; setup checks it against the requested adapter.
export const answeredBy = new WeakMap<Completion, string>();
export interface QuotaWindow { startedAt: number; resetAt: number }
// A slow upstream failure (HTTP 502/503/504/524, connection reset, stream cut
// short, or an output deadline) with no Retry-After hint benches the source for
// baseSeconds, doubling on each consecutive slow failure up to maxSeconds. A
// success resets the count. Retirement still follows the identical-failure
// streak rules in docs/router.md; this only lengthens the cooldown, and a
// provider's own Retry-After always wins.
export interface SlowUpstreamPolicy { baseSeconds: number; maxSeconds: number }
export interface Source {
  id: string;
  supportsFunctionTools?: boolean;
  // Function tools reach the model as a JSON envelope inside a prompt (FreebuffTools) instead of the provider's own
  // tool-calling interface. Such a model can only be told, not made, to call tools, so routing tries sources with
  // native tool calling first. See docs/router.md.
  jsonToolBridge?: boolean;
  // Receives inference and returns buffered text or caller-owned tool calls.
  // Aborting may consume quota but cannot execute the caller's tools.
  inferenceOnly?: boolean;
  // A source that calls output() when it first produces output gets the
  // first-output deadline. An inference-only adapter can also be bounded
  // while its entire response is buffered.
  reportsOutput?: boolean;
  // Streaming adapters may report every meaningful content, reasoning or tool
  // delta. They also receive an idle deadline after output has started.
  // Headers, role-only events and transport keepalives are not progress.
  // This inference-stream capability opts into prompt cancellation settlement;
  // its reader cleanup must remain abort-safe after the caller has returned.
  reportsProgress?: boolean;
  // Per-source deadlines, replacing the pool default: how long the source may
  // take to produce its first output, and (for reportsProgress sources) how long
  // it may stay silent once output has started. Use for providers whose healthy
  // time to first token is long.
  firstOutputMs?: number | undefined;
  idleMs?: number | undefined;
  // Opt-in cooldown policy for a congested provider whose failures are slow
  // (5xx gateway errors, resets, first-output timeouts). See SlowUpstreamPolicy.
  slowUpstream?: SlowUpstreamPolicy | undefined;
  availabilityTimeoutMs?: number | undefined;
  available(signal?: AbortSignal): Promise<boolean>;
  acceptsRequest?(request: ModelRequest): boolean;
  quotaWindow?(): QuotaWindow | undefined;
  sellerQuota?(): SellerQuota | undefined;
  healthCheck?(signal?: AbortSignal): Promise<boolean>;
  complete(request: ModelRequest, signal: AbortSignal, output?: () => void, beforeNativeWork?: () => void): Promise<Completion>;
  // Called after a failed request (not a cancellation). Must not block.
  failed?(error: SourceError): void;
  close?(): Promise<void>;
}
// A request that carries the client's function tools expects tool calls back, so the client
// keeps the agent loop. Automatic selection skips sources that run their own
// tools instead (OpenCode). A source the caller names explicitly stays eligible.
export const needsFunctionTools = (request: ModelRequest) => request.tools.some(tool => tool.type === 'function');
// Hosted or native tool types (web_search, custom, ...) that no source can run.
// Only the type name reaches the message, and only if it looks like a plain identifier.
export const unsupportedToolTypes = (request: ModelRequest) =>
  [...new Set(request.tools.filter(tool => tool.type !== 'function').map(tool => /^[\w.-]{1,64}$/.test(String(tool.type)) ? String(tool.type) : 'unknown'))].slice(0, 5);
export const toolCapable = (source: Source) => source.supportsFunctionTools === true;
export const bridgedTools = (source: Source) => source.jsonToolBridge === true;
export const NO_TOOL_SOURCE = 'No tool-capable adapter is available for a request with function tools; finish setup or retry after quota resets';
// A source that has not produced first output by this time counts as failed.
export const FIRST_OUTPUT_MS = 60000;
export class Sources {
  private router: StickyRouter | undefined;
  // Registry-aware retirement and back-off state for a fixed source chain (no routed pool).
  private chainRouter: StickyRouter | undefined;
  private observation: SourceStatus;
  private metadata = new MetadataFlights();
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
  constructor(public readonly sources: Source[], private routing?: RoutingOptions, private disabledModels: ReadonlySet<string> = new Set(), private firstOutputMs = FIRST_OUTPUT_MS) {
    if ((!sources.length && !disabledModels.size) || new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('Configure distinct grunt sources');
    this.observation = new SourceStatus(sources.map(source => source.id), routing?.now, {
      open: id => this.dispatchEligible(id), dropped: id => this.dropped?.(id),
    });
    if (routing) this.router = this.createRouter(routing);
  }
  setChainRegistry(registry: RoutingOptions['registry'], localOptIns?: RoutingOptions['localOptIns']) {
    // Mixed source configurations preserve their normal fixed route chain. This router never
    // draws or dispatches; it only tracks retirement and back-off over the shared observations.
    if (!this.router) this.chainRouter = this.createRouter({ registry, ...(localOptIns ? { localOptIns } : {}) });
  }
  // A source outside the registry beside a routed pool (docs/router.md): it is
  // selectable by model id and tried only after every routed source fails.
  private unrouted(id: string) { return this.routing?.unrouted?.has(id) ?? false; }
  private get registeredRouter() { return this.router ?? this.chainRouter; }
  private createRouter(routing: RoutingOptions) {
    return new StickyRouter(this.sources, { ...routing, pending: this.pending, disabled: this.disabledModels, observation: this.observation, attempt: this.attempt,
      dropped: id => { if (this.observation.observedAvailable(id) !== false) this.dropped?.(id); },
      observeEligible: (source, at) => {
        const context = currentDiagnosticContext();
        context?.sink?.record({ version: 1, id: randomUUID(), at, requestId: context.requestId, kind: context.kind, type: 'route.eligible', source });
      },
      observe: (source, reason, skipped) => {
        const context = currentDiagnosticContext();
        if (context) this.diagnostics?.record({ version: 1, id: randomUUID(), at: Date.now(), requestId: context.requestId, kind: context.kind,
          type: skipped ? 'route.skip' : 'route.selection', source, reason, ...(skipped ? { outcome: 'skipped' } : {}) });
      } });
  }
  // One routed call to one source, with the first-output deadline. A failure
  // (not a cancellation) is logged and reported to the source.
  private attempt = async (source: Source, request: ModelRequest, signal: AbortSignal): Promise<Completion> => {
    if (this.retired(source.id)) throw new SourceError('not_installed', `${source.id} routing is retired`);
    const timed: Source = { id: source.id, available: () => source.available(), complete: (r, s) => this.firstOutput(source, r, s) };
    try {
      const result = await this.observation.complete(timed, request, signal);
      signal.throwIfAborted();
      return result;
    }
    catch (error) {
      if (!signal.aborted && error instanceof SourceError && error.code !== 'cancelled') {
        // The fixed chain below logs its own failures.
        if (this.router && !this.unrouted(source.id)) console.error(`grunt source: ${source.id} failed (${error.code}) for model ${this.safeModel(request.model)}`);
        try { source.failed?.(error); } catch { /* Diagnostics must never affect routing. */ }
      }
      throw error;
    }
  };
  private firstOutput(source: Source, request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    const watchdog = source.reportsOutput || source.reportsProgress || source.inferenceOnly && request.model !== source.id;
    const promptCancellation = source.inferenceOnly || source.reportsProgress;
    if (!watchdog && !promptCancellation) return source.complete(request, caller);
    caller.throwIfAborted();
    const deadline = new AbortController();
    const signal = AbortSignal.any([caller, deadline.signal]);
    let timer: NodeJS.Timeout | undefined;
    let finished = false, outputStarted = false, nativeWork = false;
    let rejectCutoff: (reason: unknown) => void;
    const cutoff = new Promise<never>((_, reject) => {
      rejectCutoff = reject;
    });
    const first = source.firstOutputMs ?? this.firstOutputMs, idle = source.idleMs ?? first;
    const arm = () => {
      clearTimeout(timer);
      const limit = outputStarted ? idle : first;
      timer = setTimeout(() => {
        finished = true;
        const error = replayTimeout(`${source.id} produced no ${outputStarted ? 'further ' : ''}output within ${limit / 1000} seconds`, !nativeWork);
        deadline.abort(error);
        rejectCutoff(error);
      }, limit);
    };
    const progress = () => {
      if (finished) return;
      outputStarted = true;
      clearTimeout(timer); timer = undefined;
      if (source.reportsProgress) arm();
    };
    const cancel = () => {
      finished = true;
      // Legacy native-tool adapters own process/bridge cleanup. Let their
      // cancelled promise settle, preserving their existing initial watchdog.
      if (promptCancellation) { clearTimeout(timer); rejectCutoff(caller.reason); }
    };
    caller.addEventListener('abort', cancel, { once: true });
    // Arm before invoking adapters: an adapter may synchronously report its
    // first output, or throw before returning its promise.
    if (watchdog) arm();
    const work = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      try {
        return await source.complete(request, signal, progress, () => {
          signal.throwIfAborted();
          nativeWork = true;
        });
      } catch (error) {
        if (error instanceof SourceError && error.code === 'timeout' && source.inferenceOnly && error.replay === undefined) error.replay = 'safe';
        throw error;
      }
    });
    // Do not wait for a hung source to clean up; it settles on its own.
    work.catch(() => {});
    return Promise.race([work, cutoff]).finally(() => {
      finished = true;
      clearTimeout(timer);
      caller.removeEventListener('abort', cancel);
    });
  }
  private safeModel(model: string) { return ['grunt', 'milo', ...this.sources.map(source => source.id)].includes(model) ? model : 'grunt'; }
  healthy(id: string) { this.registeredRouter?.healthy(id); this.observation.healthy(id); }
  available(source: Source) {
    return this.metadata.run(source.id, signal => this.observation.available(source, false, undefined, signal), undefined, source.availabilityTimeoutMs);
  }
  openRoute(id: string) { return this.observation.observedAvailable(id) !== false && this.dispatchEligible(id); }
  dispatchEligible(id: string, request?: ModelRequest) {
    const router = this.registeredRouter;
    const source = this.sources.find(source => source.id === id);
    return source !== undefined && (!request || !source.acceptsRequest || source.acceptsRequest(request))
      && !this.disabledModels.has(id) && !this.pending.has(id) && router !== undefined && router.listed(id)
      && !router.retired(id) && (router.cooldown(id)?.until ?? 0) <= (this.routing?.now ?? Date.now)();
  }
  retired(id: string) { return this.registeredRouter?.retired(id) ?? false; }
  // A newer registry publication that still lists a retired route gives it a fresh try.
  unretire(ids: readonly string[]) { for (const id of ids) if (this.retired(id)) this.registeredRouter?.verified(id); }
  // Hot-add a source for a newly listed adapter; the routers share this array.
  add(source: Source) { this.sources.push(source); }
  setDiagnostics(store: DiagnosticsStore) { this.diagnostics = store; this.observation.setDiagnostics(store); }
  setRoutingHistory(store: RoutingHistory) { return this.observation.setRoutingHistory(store); }
  setFeedback(feedback: Parameters<SourceStatus['setFeedback']>[0]) { this.observation.setFeedback(feedback); }
  // The registry's liveliness scores weight the routers' draw (docs/router.md).
  setRegistryScores(score: (id: string) => number | null | undefined) { for (const router of [this.router, this.chainRouter]) router?.useRegistryScores(score); }
  flushRoutingHistory() { return this.observation.flushRoutingHistory(); }
  diagnosticStore() { return this.diagnostics; }
  setMaintenance(reader: () => Record<string, MaintenanceEntry>) { this.maintenance = reader; }
  status(): PoolSnapshot {
    const router = this.registeredRouter;
    const snapshot = this.observation.snapshot({ ids: this.sources.map(source => source.id), disabled: this.disabledModels,
      retired: id => this.retired(id), pending: this.pending, verifying: this.verifying, preparing: this.preparing,
      ...(this.router ? { listed: (id: string) => this.unrouted(id) || this.router!.listed(id) } : {}),
      ...(router ? { cooldown: (id: string) => router.cooldown(id) } : {}),
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
      if (this.pending.has(id) || this.verifying.has(id)) return { outcome: 'deferred', code: 'foreground' };
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
      if (id === 'freepi') {
        guard = this.observation.guard(id);
        // Free-Pi must not publish new session traces during idle checks.
        const available = await (source.healthCheck?.(signal) ?? source.available(signal));
        signal.throwIfAborted();
        const newer = newerEvidence();
        if (newer) return newer;
        if (!available) throw new SourceError('not_installed', `${id} read-only metadata is unavailable`);
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
      // This fixed synthetic probe never contains caller or repository data.
      await this.observation.complete(guarded, { model: id, cwd, messages: [{ role: 'user', content: 'Say hello in one short sentence.' }], tools: [], stream: false, maxTokens: 1024, publicContext: true }, signal, guard);
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
      return { outcome: 'failed', code: failure.code, ...(retryAt !== undefined && Number.isFinite(retryAt) ? { retryAt } : {}) };
    } finally {
      this.checking.delete(id);
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  }
  async models() {
    const available = await Promise.all(this.sources.map(async s => {
      if (this.retired(s.id) || this.pending.has(s.id) || this.router && !this.unrouted(s.id) && !this.router.listed(s.id)) return null;
      const available = await this.available(s).catch(error => {
        if (error instanceof SourceError && error.code === 'timeout') return false;
        throw error;
      });
      if (!available) return null;
      if (this.registeredRouter?.needsHealthCheck(s.id) && s.healthCheck) {
        await this.metadata.run(`health:${s.id}`, signal => this.observation.available(s, true, () => this.registeredRouter?.healthy(s.id), signal),
          undefined, s.availabilityTimeoutMs ?? 30000).catch(() => false);
      }
      return this.retired(s.id) ? null : s.id;
    }));
    return ['grunt', ...available.filter((id): id is string => id !== null)];
  }
  // When no source can answer, start background recovery so the next request has one.
  setRecovery(recover: () => void) { this.recover = recover; }
  private recover: (() => void) | undefined;
  // A route left the open set, including an observed availability loss.
  setRouteDropped(dropped: (id: string) => void) { this.dropped = dropped; }
  private dropped: ((id: string) => void) | undefined;
  async complete(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    const parent = currentDiagnosticContext();
    const actor = parent?.actor ? { actor: parent.actor } : {};
    const context: DiagnosticContext = { ...actor, requestId: parent?.requestId ?? randomUUID(), kind: this.verifying.has(request.model) ? 'setup' : parent?.kind ?? 'user', ...(this.diagnostics ? { sink: this.diagnostics } : {}) };
    return withDiagnosticContext(context, async () => {
      const started = Date.now(), startedMono = performance.now(), base = { version: 1 as const, requestId: context.requestId, kind: context.kind };
      if (!parent?.requestRecorded) this.diagnostics?.record({ ...base, id: randomUUID(), at: started, type: 'request.start' });
      try {
        const result = await this.route(request, signal);
        const source = answeredBy.get(result);
        if (parent?.requestRecorded && result.finishReason === 'length') parent.incomplete = true;
        if (!signal.aborted && source && result.finishReason !== 'length' && (result.text.trim() || result.calls?.length)) {
          this.diagnostics?.record({ ...base, id: randomUUID(), at: Date.now(), type: 'request.output', source });
        }
        if (!parent?.requestRecorded) this.diagnostics?.record({ ...base, id: randomUUID(), at: Date.now(), type: 'request.finish', outcome: signal.aborted ? 'cancelled' : 'passed', durationMs: Math.max(0, performance.now() - startedMono),
          ...(source ? { source } : {}), ...(result.finishReason === 'length' ? { failureReason: 'length' as const } : {}),
          ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }), ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }) });
        return result;
      } catch (error) {
        if (parent?.requestRecorded) parent.errorCode = signal.aborted ? 'cancelled' : error instanceof SourceError ? error.code : 'upstream';
        if (!parent?.requestRecorded) this.diagnostics?.record({ ...base, id: randomUUID(), at: Date.now(), type: 'request.finish', outcome: signal.aborted ? 'cancelled' : 'failed', durationMs: Math.max(0, performance.now() - startedMono),
          errorCode: signal.aborted ? 'cancelled' : error instanceof SourceError ? error.code : 'upstream' });
        if (error instanceof SourceError && (error.code === 'quota' || error.code === 'not_installed' || error.code === 'logged_out')) this.recover?.();
        throw error;
      }
    });
  }
  private async route(request: ModelRequest, signal: AbortSignal): Promise<Completion> {
    signal.throwIfAborted();
    // Automatic selection translates function tools only. Naming a source keeps
    // that source's own behavior (OpenCode and Codex run their own tools).
    if (request.model === 'grunt' || request.model === 'milo' || !this.sources.some(source => source.id === request.model)) {
      const unsupported = unsupportedToolTypes(request);
      if (unsupported.length) throw new RequestError(`Unsupported tool type${unsupported.length > 1 ? 's' : ''}: ${unsupported.join(', ')}. Grunt accepts function tools only; remove the hosted tool from the client (for Codex, set web_search = "disabled").`);
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
    if (this.router) {
      const unrouted = this.sources.filter(source => this.unrouted(source.id));
      if (!unrouted.length) return this.router.complete(request, signal);
      // Naming an unrouted source selects it alone, as in the fixed chain.
      if (unrouted.some(source => source.id === request.model)) return this.chain(request, signal);
      return this.router.complete(request, signal, (reason, signal) => this.chain(request, signal, unrouted, reason));
    }
    return this.chain(request, signal);
  }
  // The fixed chain: first success in source order, or the named source alone.
  private async chain(request: ModelRequest, signal: AbortSignal, pool: Source[] = this.sources, routedFailure?: SourceError): Promise<Completion> {
    await this.observation.refreshRoutingHistory();
    signal.throwIfAborted();
    const known = this.sources.some(s => s.id === request.model);
    // Older harness configurations may still request the former model name.
    const automatic = request.model === 'grunt' || request.model === 'milo' || !known;
    if (automatic && !['grunt', 'milo'].includes(request.model)) console.error('grunt model mapping: unrecognized model -> grunt');
    const toolsRequired = automatic && needsFunctionTools(request);
    const candidates = automatic ? pool.filter(s => !toolsRequired || toolCapable(s)) : pool.filter(s => s.id === request.model);
    let last = routedFailure ?? new SourceError('not_installed', toolsRequired ? NO_TOOL_SOURCE : `No source for model ${this.safeModel(request.model)}`);
    // A routed pool may report quota for general exhaustion without a retry
    // hint. A concrete hint or an actual quota failure can guide the client.
    let quota = routedFailure?.code === 'quota' && routedFailure.retryAfter !== undefined ? routedFailure : undefined;
    let attempted = false;
    for (const source of candidates) {
      signal.throwIfAborted();
      if (this.pending.has(source.id) || this.retired(source.id) || this.registeredRouter?.trialBusy(source.id)
        || this.chainRouter?.listed(source.id) && !this.chainRouter.supportsInput(source.id, request.imageInput)
        || this.chainRouter && knownAdapters.has(source.id) && !this.dispatchEligible(source.id)) continue;
      if (source.acceptsRequest && !source.acceptsRequest(request)) {
        if (!automatic) throw new SourceError('refused', `${source.id} requires approved request context`);
        continue;
      }
      const context = currentDiagnosticContext();
      if (context) this.diagnostics?.record({ version: 1, id: randomUUID(), at: Date.now(), requestId: context.requestId, kind: context.kind, type: 'route.selection', source: source.id,
        ...(!automatic ? { reason: 'explicit' as const } : attempted || pool !== this.sources ? { reason: 'fallback' as const } : {}) });
      attempted = true;
      let completion: Completion;
      const release = this.registeredRouter?.claimTrial(source.id) ?? (() => {});
      try { completion = await this.attempt(source, request, signal); }
      catch (error) {
        if (signal.aborted || (error instanceof SourceError && error.code === 'cancelled')) {
          console.error(`grunt source: ${source.id} cancelled for model ${this.safeModel(request.model)}`);
          signal.throwIfAborted();
          throw error;
        }
        const failure = error instanceof SourceError ? error : new SourceError('upstream', `Source ${source.id} failed`);
        await this.chainRouter?.recordFailure(source.id, failure);
        signal.throwIfAborted();
        console.error(`grunt source: ${source.id} failed (${failure.code}) for model ${this.safeModel(request.model)}`);
        if (!canReplay(failure)) throw failure;
        if (failure.code === 'quota' && (!quota || (failure.retryAfter ?? Infinity) < (quota.retryAfter ?? Infinity))) quota = failure;
        if (!(routedFailure instanceof RequestError) || !(localRequestRefusal(failure) || ['not_installed', 'logged_out'].includes(failure.code))) {
          last = failure;
        }
        continue;
      } finally { release(); }
      console.error(`grunt source: ${source.id} answered model ${this.safeModel(request.model)}`);
      answeredBy.set(completion, source.id);
      return completion;
    }
    throw quota ?? last;
  }
  async close() {
    this.metadata.close();
    await Promise.all([this.router?.close(), this.chainRouter?.close()]);
    await Promise.allSettled(this.sources.map(s => s.close?.()));
    await this.flushRoutingHistory();
  }
}
export class Gateway implements Source {
  id = 'gateway';
  readonly supportsFunctionTools = true;
  readonly inferenceOnly = true;
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
        body: JSON.stringify({ model: 'grunt', messages: request.messages, tools: request.tools.length ? request.tools : undefined, stream: false, max_tokens: request.maxTokens })
      });
    } catch { signal.throwIfAborted(); throw new SourceError('upstream', 'grunt gateway is unavailable'); }
    if (!response.ok) throw new SourceError(response.status === 401 || response.status === 403 ? 'logged_out' : response.status === 429 ? 'quota' : 'upstream', `grunt gateway returned HTTP ${response.status}`);
    const body = await response.json() as { choices?: { finish_reason?: unknown; message?: { content?: string | null; tool_calls?: ToolCall[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const message = body.choices?.[0]?.message;
    if (lengthLimited(body.choices?.[0]?.finish_reason)) return truncatedCompletion(message?.content, body.usage);
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
