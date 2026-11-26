import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { buildRecoveryAudit, measureBeatAPI } from './recovery-audit.js';
import { renderFleetHandoff, renderFleetReport } from './fleet-report.js';
import type { DiagnosticEvent, DiagnosticMetrics } from './local/diagnostics.js';

const hour = 3_600_000;
const since = Date.UTC(2026, 10, 24, 5);
const window = { since, until: since + 24 * hour };
function event(type: DiagnosticEvent['type'], offset: number, patch: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return { version: 1, id: randomUUID(), at: since + offset, type, requestId: randomUUID(), kind: 'user', runtimeVersion: '0.10.8', ...patch };
}
function traceEvents(requestId: string, items: [DiagnosticEvent['type'], number, Partial<DiagnosticEvent>][] = []) {
  return items.map(([type, at, patch], i) => event(type, at, { requestId, seq: i + 1, ...patch }));
}
function metrics(interval: typeof window, events: DiagnosticEvent[]): DiagnosticMetrics {
  return {
    version: 1, streamId: randomUUID(), ingestionHealth: { enabled: true, available: true, queued: 0, droppedEvents: 0 },
    window: { ...interval, alignedSince: interval.since, alignedUntil: interval.until },
    coverage: { startedAt: since - hour, retainedFrom: since - hour, deduplicationFloor: 0, droppedLateEvents: 0,
      overflowEvents: 0, available: true, droppedEvents: 0, persistentDroppedEvents: 0 },
    buckets: events.map(e => ({ hour: Math.floor(e.at / hour) * hour, dimensions: { type: e.type, kind: e.kind, ...(e.source ? { source: e.source } : {}) },
      count: 1, durationCount: 0, durationSumMs: 0, durationMaxMs: 0, durationHistogram: [],
      inputTokens: 0, outputTokens: 0, unknownInput: 0, unknownOutput: 0 })),
    histogram: { upperBoundsMs: [], overflowBucket: true, cumulative: false },
    limits: { retentionDays: 30, maxRows: 50000, maxSeriesPerHour: 256, maxSeenEventIds: 200000 }
  };
}

it('attributes a crossing request by its finish and unions overlapping failures through the winning attempt', () => {
  const requestId = randomUUID();
  const kilo = { attemptId: randomUUID(), source: 'kilo' }, open = { attemptId: randomUUID(), source: 'opencode' };
  const gone = { attemptId: randomUUID(), source: 'runcrate' }, win = { attemptId: randomUUID(), source: 'mistral-vibe' };
  const events = traceEvents(requestId, [
    ['request.start', -2_000, {}], ['route.eligible', -1_950, { source: win.source }],
    ['attempt.start', -1_900, kilo], ['attempt.start', -500, open], ['attempt.start', 0, gone],
    ['attempt.failure', 1_000, { ...kilo, failureReason: 'response_content', replaySafe: true }],
    ['attempt.finish', 1_100, { ...kilo, failureReason: 'response_content', outcome: 'failed', durationMs: 3_000 }],
    ['attempt.finish', 1_200, { ...gone, outcome: 'cancelled' }], ['attempt.start', 1_300, win],
    ['attempt.finish', 2_000, { ...win, outcome: 'passed', durationMs: 700 }],
    ['request.output', 2_100, { source: win.source }], ['request.finish', 2_200, { source: win.source, outcome: 'passed', durationMs: 4200 }],
    ['attempt.failure', 2_800, { ...open, replaySafe: false }],
    ['attempt.finish', 2_800, { ...open, outcome: 'failed', errorCode: 'timeout', durationMs: 3300 }]
  ]);
  const result = buildRecoveryAudit(events, window, metrics(window, events));
  expect(result).toMatchObject({ recovered: 1, passed: 1, classified: 1, unfinished: 0, failedMs: 4000, countsMatch: true });
  const item = result.slowest[0]!;
  expect(item).toMatchObject({ elapsedMs: 4200, acceptedMs: 4000, firstUsableMs: 4100 });
  expect(item.attempts.map(a => [a.source, a.firstEligibleMs, a.failureObservedMs, a.replaySafeMs])).toEqual([
    [kilo.source, null, 3000, 3000], [open.source, null, 4800, null], [gone.source, null, null, null], [win.source, 50, null, null]
  ]);
  const html = renderFleetReport('2026-11-24', undefined, {}, result);
  expect(html.indexOf('4.00 s in failed attempts')).toBeLessThan(html.indexOf('<h2>Coverage unavailable'));
  expect(html).toContain('First usable output 4.10 s');
  expect(html).toContain('Replay blocked at 4.80 s');
  expect(renderFleetHandoff(undefined, result).split('\n')[0]).toBe('4.00 s in failed attempts before successful answers');
});

it('counts successes with missing phases as unclassified and keeps cancelled, incomplete and open outcomes distinct', () => {
  const id = randomUUID(), source = 'livekit';
  const attempt = { attemptId: randomUUID(), source };
  const events = [
    ...traceEvents(id, [
      ['request.start', 0, {}],
      ['attempt.start', 1, { attemptId: randomUUID(), source: 'kilo' }],
      ['attempt.start', 2, attempt], ['attempt.finish', 3, { ...attempt, outcome: 'passed' }],
      ['request.finish', 4, { source, outcome: 'passed', durationMs: 4 }]
    ]),
    event('request.finish', 5, { outcome: 'cancelled' }),
    event('request.finish', 6, { outcome: 'passed', source, failureReason: 'length' }),
    event('request.finish', 7, { outcome: 'passed', reason: 'local' }),
    event('request.start', 8),
    event('request.finish', window.until - window.since, { outcome: 'passed' })
  ];
  expect(buildRecoveryAudit(events, window)).toMatchObject({ passed: 1, classified: 0, recovered: 0, failedMs: 0,
    countsMatch: false, unfinished: 1, cancelled: 1, truncated: 1, slowest: [] });
  const missingId = events.map(e => e.type === 'attempt.start' && e.source === 'kilo'
    ? event('attempt.finish', 1, { requestId: id, source: 'kilo', outcome: 'failed' }) : e);
  expect(buildRecoveryAudit(missingId, window)).toMatchObject({ passed: 1, classified: 0 });
});

it('counts terminal user failures and ranks complete traces by request duration', () => {
  const oldest = randomUUID(), first = { attemptId: randomUUID(), source: 'kilo' };
  const last = { attemptId: randomUUID(), source: 'numes' };
  const crossing = traceEvents(oldest, [
    ['request.start', -10_000, {}], ['attempt.start', -9_000, first], ['attempt.start', -8_000, last],
    ['attempt.finish', -7_000, { ...last, outcome: 'failed', errorCode: 'timeout' }],
    ['attempt.finish', 0, { ...first, outcome: 'failed', errorCode: 'upstream' }],
    ['request.finish', 100, { outcome: 'failed', failureReason: 'response_empty', errorCode: 'upstream' }]
  ]);
  const other = Array.from({ length: 5 }, (_, i) => traceEvents(randomUUID(), [
    ['request.start', 0, {}], ['attempt.start', 1, first],
    ['attempt.finish', 2, { ...first, outcome: 'failed', errorCode: 'timeout' }],
    ['request.finish', 3, { source: first.source, outcome: 'failed', errorCode: 'timeout', durationMs: 500 + i }]
  ])).flat();
  const broken = traceEvents(randomUUID(), [
    ['request.start', 0, {}], ['attempt.start', 1, first],
    ['request.finish', 20_000, { outcome: 'failed', errorCode: 'upstream' }]
  ]);
  const events = [...crossing, ...other, ...broken,
    event('request.finish', 20_001, { outcome: 'failed', durationMs: 20_001 }),
    event('request.finish', 20_002, { outcome: 'cancelled' }),
    event('request.finish', 20_003, { outcome: 'failed', kind: 'maintenance' }),
    event('request.finish', window.until - since, { outcome: 'failed' })];
  const result = buildRecoveryAudit(events, window, metrics(window, events));
  expect(result).toMatchObject({
    failed: 8, classifiedFailures: 6, terminalFailedMs: 12_610, cancelled: 1, countsMatch: true,
    failuresByReason: { response_empty: 1, timeout: 5, upstream: 1, unknown: 1 }, failedMs: 0
  });
  expect(result.slowestFailures.map(row => row.elapsedMs)).toEqual([10_100, 504, 503, 502, 501]);
  expect(result.slowestFailures[0]).toMatchObject({
    requestId: oldest, source: first.source, errorCode: 'upstream', failureReason: 'response_empty',
    attempts: [
      { source: first.source, outcome: 'failed', failure: 'upstream' },
      { source: last.source, outcome: 'failed', failure: 'timeout' }
    ]
  });
  expect(result.slowestFailures[1]).toMatchObject({ source: first.source, errorCode: 'timeout', failureReason: null });
});

it('compares matched exposure and requires validated access for a recovery delay', () => {
  const baseline = { since, until: since + hour, runtimeVersion: '0.9.8' };
  const current = { since: since + 2 * hour, until: since + 3 * hour, runtimeVersion: '0.9.9' };
  const recovery = { since: since + 3 * hour, until: since + 4 * hour, runtimeVersion: '0.9.9', restoredAt: since + 3 * hour + 5000 };
  const account = { source: 'beatapi', endpointLabel: 'account', httpMethod: 'GET', kind: 'diagnostic' } as const;
  const denied = { ...account, httpStatus: 403 } as const;
  const events = [
    event('transport.finish', 100, { ...denied, runtimeVersion: baseline.runtimeVersion }),
    event('transport.finish', 200, { ...denied, runtimeVersion: baseline.runtimeVersion }),
    event('transport.finish', 2 * hour + 100, { ...denied, runtimeVersion: current.runtimeVersion }),
    event('transport.finish', 2 * hour + 200, { ...denied, kind: 'maintenance', runtimeVersion: current.runtimeVersion }),
    event('transport.finish', 3 * hour + 8000, { ...account, runtimeVersion: recovery.runtimeVersion, httpStatus: 200 }),
    event('account.available', 3 * hour + 9000, { ...account, runtimeVersion: recovery.runtimeVersion })
  ];
  const coverage = { baseline: metrics(baseline, events), current: metrics(current, events), recovery: metrics(recovery, events) };
  const result = measureBeatAPI(events, { baseline, current, recovery }, coverage);
  expect(result).toEqual({ comparison: {
    before: { denied: 2, deniedAccountHours: 1, checksPerDeniedAccountHour: 2 },
    after: { denied: 1, deniedAccountHours: 1, checksPerDeniedAccountHour: 1 }
  }, rediscoveryMs: 4000 });
  expect(measureBeatAPI(events.slice(0, -1), { baseline, current, recovery }, coverage).rediscoveryMs).toBeNull();
  expect(measureBeatAPI(events.slice(1), { baseline, current }, coverage).comparison).toBeNull();
  expect(measureBeatAPI(events, { baseline, current: { ...current, until: current.until + hour } }, coverage).comparison).toBeNull();
});
