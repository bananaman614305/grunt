import type { DiagnosticEvent } from './diagnostics.js';
import type { Sources } from './source.js';

export const OBSERVATION_PATH = '/v1/observe';
export const OBSERVATION_LIMIT = 10;

export function observationLimit(value: string | undefined) {
  if (value === undefined) return OBSERVATION_LIMIT;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Observation limit must be a nonnegative integer');
  return Number(value);
}

export interface ObservationRuntime {
  version?: string | undefined;
  startedAt: number;
  port: number;
  readiness?: 'starting' | 'ready' | 'failed';
  config?: {
    // Anonymous PostHog usage telemetry (docs/router.md#4-usage-telemetry).
    telemetry: boolean;
    backgroundAccountAcquisition: boolean;
    registry: 'bundled_and_public' | 'custom';
    // These settings may contain credentials in the URL or in their value.
    redactedSettings: string[];
  };
}

const errorDescriptions: Record<NonNullable<DiagnosticEvent['errorCode']>, string> = {
  not_installed: 'Route is unavailable or setup is incomplete',
  logged_out: 'Provider authentication is unavailable',
  quota: 'Provider quota or rate limit was reached',
  timeout: 'Provider attempt timed out',
  upstream: 'Provider attempt failed',
  refused: 'Request was refused',
  cancelled: 'Request was cancelled'
};

function errorText(event: DiagnosticEvent, firstTokenAt?: number | null) {
  const { errorCode, failureReason, httpStatus, networkCode, exitCode } = event;
  const description = failureReason === 'deadline' && errorCode === 'timeout'
    ? firstTokenAt == null ? 'First-output deadline elapsed' : 'Output idle deadline elapsed'
    : errorCode ? errorDescriptions[errorCode] : event.outcome === 'failed' ? 'Request failed' : null;
  if (description === null) return null;
  const detail = [failureReason, httpStatus === undefined ? undefined : `HTTP ${httpStatus}`,
    networkCode, exitCode === undefined ? undefined : `exit ${exitCode}`].filter(Boolean);
  return detail.length ? `${description} (${detail.join(', ')})` : description;
}

function usage(event?: Pick<DiagnosticEvent, 'inputTokens' | 'outputTokens' | 'reasoningTokens'>) {
  const { inputTokens, outputTokens, reasoningTokens } = event ?? {};
  return { input: inputTokens ?? null, output: outputTokens ?? null, reasoning: reasoningTokens ?? null,
    outputExcludingReasoning: outputTokens !== undefined && reasoningTokens !== undefined && outputTokens >= reasoningTokens
      ? outputTokens - reasoningTokens : null };
}

function observeRequest(events: DiagnosticEvent[], at: number, live?: { positions: ReadonlyMap<string, number | null>; progress: ReadonlyMap<string, number> }) {
  const first = events[0]!;
  const start = events.find(event => event.type === 'request.start');
  const finishedIndex = events.findLastIndex(event => event.type === 'request.finish');
  const finish = events[finishedIndex];
  if (finish) events = events.slice(0, finishedIndex + 1);
  const input = events.find(event => event.type === 'request.input');
  const decisions: { at: number; route: string; decision: 'eligible' | 'selected' | 'skipped'; reason: DiagnosticEvent['reason'] | null }[] = [];
  const attempts = new Map<string, DiagnosticEvent[]>();
  let selectedRoute: string | null = null;
  let activeAttemptId: string | undefined;
  let state: string | null = start ? 'receiving_request' : null;
  let stateSince: number | null = start?.at ?? null;
  const transition = (next: string, since: number, restart = false) => {
    if (state !== next || restart) { state = next; stateSince = since; }
  };
  for (const event of events) {
    if (event.attemptId) {
      const entries = attempts.get(event.attemptId);
      if (entries) entries.push(event);
      else attempts.set(event.attemptId, [event]);
    }
    if (event.source && ['route.eligible', 'route.selection', 'route.skip'].includes(event.type)) {
      const decision = event.type === 'route.selection' ? 'selected' : event.type === 'route.skip' ? 'skipped' : 'eligible';
      decisions.push({ at: event.at, route: event.source, decision, reason: event.reason ?? null });
      if (decision === 'selected') selectedRoute = event.source;
    }
    switch (event.type) {
      case 'request.input': transition('routing', event.at); break;
      case 'request.phase':
        if (event.phase) transition(event.phase, event.at);
        if (event.source) selectedRoute = event.source;
        break;
      case 'attempt.start':
        activeAttemptId = event.attemptId;
        selectedRoute = event.source ?? selectedRoute;
        transition('waiting_for_output', event.at, true);
        break;
      case 'attempt.queue': if (activeAttemptId && event.attemptId === activeAttemptId) transition('queued', event.at, true); break;
      case 'attempt.dequeue':
      case 'attempt.dispatch': if (activeAttemptId && event.attemptId === activeAttemptId) transition('waiting_for_output', event.at); break;
      case 'attempt.progress': if (activeAttemptId && event.attemptId === activeAttemptId) transition('receiving_output', event.at); break;
      case 'attempt.finish':
        if (activeAttemptId && event.attemptId === activeAttemptId) {
          activeAttemptId = undefined;
          transition(event.outcome === 'passed' ? 'returning_response' : 'routing', event.at);
        }
        break;
      case 'request.finish': transition(event.outcome ?? 'completed', event.at); break;
    }
  }
  const attemptList = [...attempts].map(([id, events]) => {
    const finishIndex = events.findLastIndex(event => event.type === 'attempt.finish');
    const finish = events[finishIndex];
    if (finish) events = events.slice(0, finishIndex + 1);
    const start = events.find(event => event.type === 'attempt.start');
    const firstTokenAt = events.find(event => event.type === 'attempt.progress')?.at ?? null;
    const dispatches = events.filter(event => event.type === 'attempt.dispatch').map(event => ({
      at: event.at, model: event.model ?? null, account: event.account ?? null, maxOutputTokens: event.maxOutputTokens ?? null
    }));
    const lastDispatch = dispatches.at(-1);
    const failure = events.findLast(event => event.type === 'attempt.failure');
    return {
      id, provider: start?.source ?? finish?.source ?? events.find(event => event.source)?.source ?? null,
      account: lastDispatch?.account ?? null, model: finish?.model ?? lastDispatch?.model ?? null,
      startedAt: start?.at ?? null, firstTokenAt, lastProgressAt: finish?.lastProgressAt ?? live?.progress.get(id) ?? firstTokenAt,
      endedAt: finish?.at ?? null, durationMs: finish?.durationMs ?? null,
      outcome: finish?.outcome ?? null, providerFinishReason: finish?.providerFinishReason ?? null,
      finishReason: finish?.finishReason ?? null, hadToolCalls: finish?.hadToolCalls ?? null,
      tokens: usage(finish), maxOutputTokens: lastDispatch?.maxOutputTokens ?? null, requestedMaxOutputTokens: start?.maxOutputTokens ?? null,
      responseBytes: finish?.responseBytes ?? null, errorCode: finish?.errorCode ?? null,
      errorText: finish ? errorText(finish, firstTokenAt) : null, failureReason: finish?.failureReason ?? failure?.failureReason ?? null,
      httpStatus: finish?.httpStatus ?? failure?.httpStatus ?? null, retryAfterSeconds: finish?.retryAfterSeconds ?? null,
      replaySafe: failure?.replaySafe ?? null, dispatches,
      transport: events.filter(event => event.type === 'transport.finish').map(event => ({
        at: event.at, type: event.transport ?? null, endpoint: event.endpointLabel ?? null, method: event.httpMethod ?? null,
        status: event.httpStatus ?? null, networkCode: event.networkCode ?? null, exitCode: event.exitCode ?? null,
        durationMs: event.durationMs ?? null, outcome: event.outcome ?? null, retryAfterSeconds: event.retryAfterSeconds ?? null,
        errorText: errorText(event)
      }))
    };
  });
  const lastAttempt = attemptList.at(-1);
  return {
    id: first.requestId, kind: first.kind, actor: start?.actor ?? first.actor ?? null,
    caller: start?.caller ?? null, endpoint: start?.endpoint ?? null,
    model: input?.model ?? start?.model ?? null, selectedRoute: finish?.reason === 'local' ? 'local' : finish?.source ?? selectedRoute,
    startedAt: start?.at ?? null, endedAt: finish?.at ?? null, durationMs: finish?.durationMs ?? (start ? Math.max(0, (finish?.at ?? at) - start.at) : null),
    state, stateSince, stateDurationMs: stateSince === null ? null : Math.max(0, at - stateSince),
    queuePosition: activeAttemptId ? live?.positions.get(activeAttemptId) ?? null : null,
    outcome: finish?.outcome ?? null, httpStatus: finish?.httpStatus ?? null,
    errorCode: finish?.errorCode ?? null, errorText: finish ? errorText(finish) : null,
    promptBytes: input?.promptBytes ?? null, responseBytes: finish?.responseBytes ?? lastAttempt?.responseBytes ?? null,
    maxOutputTokens: input?.maxOutputTokens ?? null, tokens: usage(finish?.inputTokens !== undefined || finish?.outputTokens !== undefined
      ? { ...finish, ...(lastAttempt?.tokens.reasoning == null ? {} : { reasoningTokens: lastAttempt.tokens.reasoning }) }
      : events.findLast(event => event.type === 'attempt.finish' && event.outcome === 'passed')),
    attempts: attemptList, routeDecisions: decisions
  };
}

export async function observeDaemon(sources: Sources, limit: number, runtime: ObservationRuntime) {
  const observation = await sources.diagnosticStore()?.observation(limit);
  const at = observation?.at ?? Date.now();
  const inFlight = (observation?.inFlight ?? []).map(request => observeRequest(request.events, at, request));
  const recent = new Map<string, DiagnosticEvent[]>();
  const finishes = new Map<string, DiagnosticEvent>();
  for (const event of observation?.recent ?? []) {
    const entries = recent.get(event.requestId);
    if (entries) entries.push(event);
    else recent.set(event.requestId, [event]);
    if (event.type === 'request.finish') { finishes.delete(event.requestId); finishes.set(event.requestId, event); }
  }
  const activeIds = new Set(inFlight.map(request => request.id));
  const completed = [...finishes.values()].reverse().sort((a, b) => b.at - a.at)
    .filter(event => !activeIds.has(event.requestId)).slice(0, limit)
    .map(event => observeRequest(recent.get(event.requestId)!, at));
  return {
    version: 1, observedAt: at,
    daemon: {
      version: runtime.version ?? null, uptimeMs: Math.max(0, at - runtime.startedAt), readiness: runtime.readiness ?? 'ready',
      config: { host: '127.0.0.1', port: runtime.port, ...runtime.config, ...sources.observationConfig() }
    },
    diagnostics: { historyAvailable: observation?.historyAvailable ?? false, health: observation?.health ?? null, losses: observation?.losses ?? null },
    inFlight, completed, routes: sources.observationRoutes()
  };
}

export type Observation = Awaited<ReturnType<typeof observeDaemon>>;
