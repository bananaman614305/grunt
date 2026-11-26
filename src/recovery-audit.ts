import { bundledRegistry } from './registry.js';
import type { DiagnosticEvent, DiagnosticMetrics } from './local/diagnostics.js';

type Window = { since: number; until: number };
type Coverage = Pick<DiagnosticMetrics, 'window' | 'coverage' | 'buckets'>;
type Event = DiagnosticEvent;
type Interval = [number, number];
type Exposure = Window & { runtimeVersion: string };
export interface BeatAPIExposure {
  baseline: Exposure;
  current: Exposure;
  recovery?: Window & { runtimeVersion: string; restoredAt: number };
}
const hour = 3_600_000;
const inWindow = (at: number, { since, until }: Window) => at >= since && at < until;
const incomplete = (e: Event) => e.failureReason === 'length';
const beatTransport = (e: Event) => e.type === 'transport.finish' && e.source === 'beatapi';
const accountCheck = (e: Event) => beatTransport(e) && e.endpointLabel === 'account' && e.httpMethod === 'GET';
const ordinaryCheck = (e: Event) => accountCheck(e) && !e.attemptId && (e.kind === 'user' || e.kind === 'diagnostic');
const unionDuration = (intervals: Interval[]) => {
  let duration = 0, end = -Infinity;
  for (const [start, finish] of intervals.sort((a, b) => a[0] - b[0])) {
    duration += Math.max(0, finish - Math.max(end, start));
    end = Math.max(end, finish);
  }
  return duration;
};

function tracePhases(events: Event[], finish: Event) {
  const starts = events.filter(e => e.type === 'request.start');
  const start = starts.length === 1 ? starts[0] : undefined;
  if (!start || start.at > finish.at || events.filter(e => e.type === 'request.finish').length !== 1) return;
  const attempts = new Map<string, { starts: Event[]; finishes: Event[]; failures: Event[] }>();
  for (const event of events) {
    const { attemptId, type } = event;
    if (type !== 'attempt.start' && type !== 'attempt.finish' && type !== 'attempt.failure') continue;
    if (!attemptId) return;
    const attempt = attempts.get(attemptId) ?? { starts: [], finishes: [], failures: [] };
    if (type === 'attempt.start') attempt.starts.push(event);
    if (type === 'attempt.finish') attempt.finishes.push(event);
    if (type === 'attempt.failure') attempt.failures.push(event);
    attempts.set(attemptId, attempt);
  }
  const phases = [];
  for (const { starts, finishes, failures } of attempts.values()) {
    const dispatch = starts[0], terminal = finishes[0];
    if (starts.length !== 1 || finishes.length !== 1 || !dispatch || !terminal || !dispatch.source ||
      dispatch.source !== terminal.source || dispatch.at < start.at || terminal.at < dispatch.at ||
      !terminal.outcome || terminal.outcome === 'skipped') return;
    const observedFailures = failures.filter(e => e.source === dispatch.source && e.at >= dispatch.at && e.at <= terminal.at);
    const detection = observedFailures[0];
    const blocked = observedFailures.find(e => e.replaySafe === false);
    const replayable = blocked ? undefined : observedFailures.find(e => e.replaySafe === true);
    phases.push({ dispatch, terminal, detection, blocked, replayable });
  }
  return { start, phases };
}

function describeAttempts(events: Event[], start: Event, phases: NonNullable<ReturnType<typeof tracePhases>>['phases']) {
  const offset = (event: Event | undefined) => event ? event.at - start.at : null;
  return phases.sort((a, b) => (a.dispatch.seq ?? 0) - (b.dispatch.seq ?? 0)).map(({ dispatch, terminal, detection, blocked, replayable }) => ({
    source: dispatch.source!, startedMs: offset(dispatch)!, endedMs: offset(terminal)!,
    durationMs: terminal.durationMs ?? null, outcome: terminal.outcome!,
    failure: detection?.failureReason ?? terminal.failureReason ?? terminal.errorCode ?? null,
    failureObservedMs: terminal.outcome === 'failed' ? offset(detection ?? terminal) : null,
    replaySafeMs: terminal.outcome === 'failed' ? offset(replayable) : null,
    replayBlockedMs: terminal.outcome === 'failed' ? offset(blocked) : null,
    firstEligibleMs: offset(events.find(e => e.type === 'route.eligible' && e.source === dispatch.source
      && e.at >= start.at && e.at <= dispatch.at && (e.seq ?? 0) <= (dispatch.seq ?? Infinity)))
  }));
}

function trace(events: Event[], finish: Event) {
  const validated = tracePhases(events, finish);
  if (!validated) return;
  const { start, phases } = validated;
  const winners = phases.filter(({ terminal }) => terminal.outcome === 'passed' && terminal.source === finish.source && !incomplete(terminal));
  const accepted = winners[0]?.terminal;
  if (winners.length !== 1 || !accepted || accepted.at > finish.at) return;
  const output = events.find(e => e.type === 'request.output' && e.source === finish.source && e.at >= accepted.at && e.at <= finish.at);
  const elapsed = finish.durationMs ?? null;
  // Both the union and its cutoff are wall-clock timestamps. The request's
  // monotonic elapsed measurement limits error from clock adjustments.
  const failed = phases.filter(({ terminal, dispatch }) => terminal.outcome === 'failed' && dispatch.at <= (output ?? accepted).at
    && (dispatch.seq ?? 0) < (accepted.seq ?? Infinity));
  const failedMs = unionDuration(failed.map(({ dispatch, terminal }) => [dispatch.at, Math.min(terminal.at, (output ?? accepted).at)]));
  return {
    requestId: finish.requestId, runtimeVersion: finish.runtimeVersion ?? null, elapsedMs: elapsed,
    failedMs: Math.min(failedMs, elapsed ?? Infinity), recovered: failed.length > 0,
    firstUsableMs: output ? output.at - start.at : null, acceptedMs: accepted.at - start.at,
    attempts: describeAttempts(events, start, phases)
  };
}

function failureTrace(events: Event[], finish: Event) {
  const validated = tracePhases(events, finish);
  if (!validated) return;
  const { start, phases } = validated;
  if (!phases.length || phases.some(({ dispatch }) => dispatch.at > finish.at)) return;
  // A request-level failure can lack a source. Use the last failed attempt
  // visible by the time the request ended, before any later hedge cleanup.
  const lastFailure = phases.map(({ terminal }) => terminal)
    .filter(terminal => terminal.at <= finish.at && (terminal.outcome === 'failed' || incomplete(terminal)))
    .sort((a, b) => b.at - a.at || (b.seq ?? 0) - (a.seq ?? 0))[0];
  return {
    requestId: finish.requestId, runtimeVersion: finish.runtimeVersion ?? null,
    elapsedMs: finish.durationMs ?? finish.at - start.at,
    source: finish.source ?? lastFailure?.source ?? null,
    errorCode: finish.errorCode ?? null, failureReason: finish.failureReason ?? null,
    attempts: describeAttempts(events, start, phases)
  };
}

function matchingCounts(events: Event[], metrics: Coverage | undefined, window: Window, predicate: (d: DiagnosticMetrics['buckets'][number]['dimensions']) => boolean) {
  if (!metrics || metrics.window.since !== window.since || metrics.window.until !== window.until ||
    metrics.window.alignedSince !== window.since || window.until % hour ||
    !metrics.coverage.available || metrics.coverage.startedAt === null || metrics.coverage.startedAt > window.since ||
    metrics.coverage.retainedFrom === null || metrics.coverage.retainedFrom > window.since ||
    metrics.coverage.droppedEvents || metrics.coverage.droppedLateEvents || metrics.coverage.overflowEvents) return false;
  // retainedFrom covers hourly aggregates. Check each event count separately
  // because selective pruning can leave gaps anywhere in the raw journal.
  const observed = events.filter(e => inWindow(e.at, window) && predicate(e)).length;
  const counted = metrics.buckets.filter(b => inWindow(b.hour, window) && predicate(b.dimensions)).reduce((sum, b) => sum + b.count, 0);
  return observed === counted;
}

export function measureBeatAPI(events: Event[], exposure: BeatAPIExposure, coverage: { baseline?: Coverage; current?: Coverage; recovery?: Coverage }) {
  const rate = (window: Exposure, metrics?: Coverage) => {
    const transports = events.filter(e => beatTransport(e) && inWindow(e.at, window));
    if (!matchingCounts(events, metrics, window, d => d.type === 'transport.finish' && d.source === 'beatapi')
      || transports.some(e => e.runtimeVersion !== window.runtimeVersion)
      || transports.some(e => ordinaryCheck(e) && e.httpStatus !== undefined && e.httpStatus >= 200 && e.httpStatus < 300)) return null;
    const denied = transports.filter(e => ordinaryCheck(e) && e.httpStatus === 403).length;
    const deniedAccountHours = (window.until - window.since) / hour;
    return { denied, deniedAccountHours, checksPerDeniedAccountHour: denied / deniedAccountHours };
  };
  const { baseline, current, recovery } = exposure;
  const hoursMatch = baseline.since < baseline.until && current.since < current.until && baseline.until <= current.since
    && baseline.runtimeVersion !== current.runtimeVersion && baseline.until - baseline.since === current.until - current.since;
  const before = hoursMatch ? rate(baseline, coverage.baseline) : null;
  const after = hoursMatch ? rate(current, coverage.current) : null;
  const observation = recovery && matchingCounts(events, coverage.recovery, recovery, d => d.type === 'transport.finish' && d.source === 'beatapi')
    ? events.find(e => e.source === 'beatapi' && e.type === 'account.available' && e.runtimeVersion === recovery.runtimeVersion
      && inWindow(e.at, recovery) && e.at >= recovery.restoredAt && (e.kind === 'diagnostic' || e.kind === 'user'))
    : undefined;
  return {
    comparison: before && after ? { before, after } : null,
    rediscoveryMs: observation && recovery && inWindow(recovery.restoredAt, recovery) ? observation.at - recovery.restoredAt : null
  };
}

const tierPolicy = { minimumAttempts: 20, minimumPassRate: 0.95, minimumFreeToolReplies: 3,
  maxP90DurationMs: 30_000, maxP90FirstOutputMs: 8_000, demoteBelowPassRate: 0.85 };

function p90(values: number[]) {
  if (!values.length) return null;
  return values.sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1]!;
}

function auditToolTiers(events: Event[], until: number, complete: boolean) {
  const finishes = events.filter(e => e.kind === 'user' && e.type === 'attempt.finish'
    && (e.outcome === 'passed' || e.outcome === 'failed'));
  const adapters = bundledRegistry.adapters.map(adapter => {
    const observed = finishes.filter(e => e.source === adapter.id);
    const unclassified = observed.filter(e => e.codingToolTurn === undefined).length;
    const turns = observed.filter(e => e.codingToolTurn);
    const passed = turns.filter(e => e.outcome === 'passed' && !incomplete(e));
    const passRate = turns.length ? passed.length / turns.length : null;
    const failureRate = turns.length ? (turns.length - passed.length) / turns.length : null;
    const durations = passed.flatMap(e => e.durationMs ?? []);
    const firstOutput = passed.flatMap(e => e.firstOutputMs ?? []);
    const p90DurationMs = p90(durations), p90FirstOutputMs = p90(firstOutput);
    const freeToolReplies = passed.filter(e => e.free && e.hadToolCalls).length;
    const last = turns.reduce<Event | undefined>((latest, e) => !latest || latest.at < e.at ? e : latest, undefined);
    let recommendation = 'insufficient evidence';
    if (complete && !unclassified && turns.length >= tierPolicy.minimumAttempts && passRate !== null) {
      recommendation = 'hold';
      const timed = durations.length === passed.length && p90DurationMs !== null;
      const outputTimed = firstOutput.length === passed.length && p90FirstOutputMs !== null;
      const slow = timed && p90DurationMs > tierPolicy.maxP90DurationMs
        || outputTimed && p90FirstOutputMs > tierPolicy.maxP90FirstOutputMs;
      if (adapter.tier === 'stable' && (passRate < tierPolicy.demoteBelowPassRate || slow)) recommendation = 'demotion candidate';
      if (adapter.tier === 'experimental' && passRate >= tierPolicy.minimumPassRate
        && timed && outputTimed && !slow
        && freeToolReplies >= tierPolicy.minimumFreeToolReplies && last?.free && last.outcome === 'passed' && !incomplete(last)
        && (!adapter.status || adapter.status === 'active') && (!adapter.expires || Date.parse(adapter.expires) + 24 * hour >= until)) {
        recommendation = 'promotion candidate';
      }
    }
    return { source: adapter.id, tier: adapter.tier, attempts: turns.length, unclassified, passRate, failureRate,
      freeToolReplies, p90DurationMs, p90FirstOutputMs, firstOutputSamples: firstOutput.length, recommendation };
  });
  return { policy: tierPolicy, complete, adapters };
}

export function buildRecoveryAudit(events: Event[], window: Window, metrics?: Coverage, beatEvidence?: ReturnType<typeof measureBeatAPI>) {
  const byRequest = new Map<string, Event[]>();
  for (const event of events) {
    if (event.kind !== 'user') continue;
    const request = byRequest.get(event.requestId) ?? [];
    request.push(event);
    byRequest.set(event.requestId, request);
  }
  const windowEvents = events.filter(e => inWindow(e.at, window));
  const finishes = windowEvents.filter(e => e.type === 'request.finish' && e.kind === 'user');
  const successes = finishes.filter(e => e.outcome === 'passed' && e.reason !== 'local' && !incomplete(e));
  const classified = successes.flatMap(e => trace(byRequest.get(e.requestId) ?? [], e) ?? []);
  const recovered = classified.filter(t => t.recovered).sort((a, b) => b.failedMs - a.failedMs);
  const failures = finishes.filter(e => e.outcome === 'failed');
  const classifiedFailures = failures.flatMap(e => failureTrace(byRequest.get(e.requestId) ?? [], e) ?? []);
  const failuresByReason = new Map<string, number>();
  for (const failure of failures) {
    const reason = failure.failureReason ?? failure.errorCode ?? 'unknown';
    failuresByReason.set(reason, (failuresByReason.get(reason) ?? 0) + 1);
  }
  const checks = windowEvents.filter(accountCheck);
  return {
    ...window,
    toolTiers: auditToolTiers(windowEvents, window.until,
      matchingCounts(events, metrics, window, d => d.kind === 'user' && d.type === 'attempt.finish')),
    passed: successes.length, classified: classified.length, recovered: recovered.length,
    failedMs: recovered.reduce((sum, item) => sum + item.failedMs, 0),
    failed: failures.length, classifiedFailures: classifiedFailures.length,
    terminalFailedMs: classifiedFailures.reduce((sum, item) => sum + item.elapsedMs, 0),
    failuresByReason: Object.fromEntries(failuresByReason),
    slowestFailures: classifiedFailures.sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 5),
    unfinished: windowEvents.filter(e => e.kind === 'user' && e.type === 'request.start'
      && !byRequest.get(e.requestId)?.some(end => end.type === 'request.finish' && end.at < window.until)).length,
    cancelled: finishes.filter(e => e.outcome === 'cancelled').length,
    truncated: finishes.filter(e => e.outcome === 'passed' && incomplete(e)).length,
    countsMatch: matchingCounts(events, metrics, window, d => d.kind === 'user' && d.type === 'request.finish')
      && matchingCounts(events, metrics, window, d => d.kind === 'user' && d.type === 'attempt.finish'),
    versions: [...new Set(finishes.map(e => e.runtimeVersion ?? 'unknown'))].sort(),
    slowest: recovered.slice(0, 5),
    beatapi: {
      ordinaryDenied: checks.filter(e => ordinaryCheck(e) && e.httpStatus === 403).length,
      otherDenied: checks.filter(e => !ordinaryCheck(e) && e.httpStatus === 403).length,
      checks: checks.length, verifiedAvailable: windowEvents.filter(e => e.source === 'beatapi' && e.type === 'account.available').length,
      ...(beatEvidence ?? { comparison: null, rediscoveryMs: null })
    }
  };
}

export type RecoveryAudit = ReturnType<typeof buildRecoveryAudit>;
