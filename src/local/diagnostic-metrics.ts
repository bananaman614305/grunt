import type { Client, InValue, Transaction } from '@libsql/client';
import type { DiagnosticEvent, DiagnosticHealth } from './diagnostics.js';

export const DIAGNOSTIC_METRIC_HOUR_MS = 3600000;
/** Non-cumulative bucket upper bounds. The last bucket represents > 1 hour. */
export const DIAGNOSTIC_LATENCY_BOUNDS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 180000, 600000, 3600000] as const;
export const DIAGNOSTIC_METRIC_MAX_ROWS = 50000;
export const DIAGNOSTIC_METRIC_MAX_SERIES_PER_HOUR = 256;
export const DIAGNOSTIC_METRIC_MAX_SEEN = 200000;
const retentionMs = 30 * 86400000;
const hour = (at: number) => Math.floor(at / DIAGNOSTIC_METRIC_HOUR_MS) * DIAGNOSTIC_METRIC_HOUR_MS;
export interface DiagnosticMetricDimensions {
  type: DiagnosticEvent['type'] | 'overflow'; kind?: DiagnosticEvent['kind']; actor?: DiagnosticEvent['actor'];
  runtimeVersion?: string; source?: string; outcome?: DiagnosticEvent['outcome']; errorCode?: DiagnosticEvent['errorCode'];
  stage?: DiagnosticEvent['stage']; workDisposition?: DiagnosticEvent['workDisposition']; failureReason?: DiagnosticEvent['failureReason'];
}
export interface DiagnosticMetricBucket {
  hour: number; dimensions: DiagnosticMetricDimensions; count: number;
  durationCount: number; durationSumMs: number; durationMaxMs: number; durationHistogram: number[];
  inputTokens: number; outputTokens: number; reasoningTokens: number; unknownInput: number; unknownOutput: number; unknownReasoning: number;
}
export interface DiagnosticMetrics {
  version: 1; streamId: string | null; window: { since: number; until: number; alignedSince: number; alignedUntil: number };
  coverage: { startedAt: number | null; retainedFrom: number | null; deduplicationFloor: number; droppedLateEvents: number; overflowEvents: number; available: boolean; droppedEvents: number; persistentDroppedEvents: number };
  ingestionHealth: DiagnosticHealth;
  histogram: { upperBoundsMs: readonly number[]; overflowBucket: true; cumulative: false };
  buckets: DiagnosticMetricBucket[];
  limits: { retentionDays: 30; maxRows: number; maxSeriesPerHour: number; maxSeenEventIds: number };
}
export const diagnosticMetricSchema = `
  CREATE TABLE IF NOT EXISTS diagnostic_metric_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS diagnostic_metric_hours (hour INTEGER NOT NULL, series TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hour,series));
  CREATE TABLE IF NOT EXISTS diagnostic_metric_seen (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS diagnostic_metric_seen_time ON diagnostic_metric_seen(at);`;
const getMeta = async (db: Pick<Client, 'execute'> | Transaction, key: string) => (await db.execute({ sql: 'SELECT value FROM diagnostic_metric_meta WHERE key=?', args: [key] })).rows[0]?.value;
const setMeta = (db: Pick<Client, 'execute'> | Transaction, key: string, value: number | string) => db.execute({ sql: 'INSERT INTO diagnostic_metric_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', args: [key, String(value)] });

/** Raw insertion, ID admission and aggregate upserts share one write transaction. */
export async function recordDiagnosticMetrics(tx: Transaction, events: DiagnosticEvent[], now: number): Promise<void> {
  const cutoff = Number(await getMeta(tx, 'deduplication_floor') ?? 0);
  const eligible = events.filter(event => event.at >= cutoff && event.at >= now - retentionMs && event.at <= now + 60000);
  if (eligible.length !== events.length) await setMeta(tx, 'dropped_late_events', Number(await getMeta(tx, 'dropped_late_events') ?? 0) + events.length - eligible.length);
  if (!eligible.length) return;
  const admitted = await tx.execute({ sql: 'INSERT OR IGNORE INTO diagnostic_metric_seen(id,at) VALUES ' + eligible.map(() => '(?,?)').join(',') + ' RETURNING id', args: eligible.flatMap(event => [event.id, event.at]) });
  const ids = new Set(admitted.rows.map(row => String(row.id)));
  const grouped = new Map<string, DiagnosticMetricBucket>();
  const seriesByHour = new Map<number, Set<string>>();
  let overflowEvents = 0;
  for (const event of eligible) {
    if (!ids.delete(event.id)) continue;
    let dimensions: DiagnosticMetricDimensions = { type: event.type };
    for (const key of ['kind', 'actor', 'runtimeVersion', 'source', 'outcome', 'errorCode', 'stage', 'workDisposition', 'failureReason'] as const) {
      if (event[key] !== undefined) Object.assign(dimensions, { [key]: event[key] });
    }
    const atHour = hour(event.at);
    let series = JSON.stringify(dimensions), known = seriesByHour.get(atHour);
    if (!known) {
      known = new Set((await tx.execute({ sql: 'SELECT series FROM diagnostic_metric_hours WHERE hour=?', args: [atHour] })).rows.map(row => String(row.series)));
      seriesByHour.set(atHour, known);
    }
    if (!known.has(series) && known.size >= DIAGNOSTIC_METRIC_MAX_SERIES_PER_HOUR - 1) {
      dimensions = { type: 'overflow' }; series = JSON.stringify(dimensions); overflowEvents++;
    }
    known.add(series);
    const key = atHour + ':' + series;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = { hour: atHour, dimensions, count: 0, durationCount: 0, durationSumMs: 0, durationMaxMs: 0,
        durationHistogram: Array.from({ length: DIAGNOSTIC_LATENCY_BOUNDS_MS.length + 1 }, () => 0),
        inputTokens: 0, outputTokens: 0, reasoningTokens: 0, unknownInput: 0, unknownOutput: 0, unknownReasoning: 0 };
      grouped.set(key, bucket);
    }
    bucket.count++;
    if (event.durationMs !== undefined) {
      bucket.durationCount++; bucket.durationSumMs += event.durationMs; bucket.durationMaxMs = Math.max(bucket.durationMaxMs, event.durationMs);
      const index = DIAGNOSTIC_LATENCY_BOUNDS_MS.findIndex(bound => event.durationMs! <= bound);
      bucket.durationHistogram[index < 0 ? DIAGNOSTIC_LATENCY_BOUNDS_MS.length : index]!++;
    }
    if (event.type === 'attempt.finish') {
      if (event.inputTokens === undefined) bucket.unknownInput++; else bucket.inputTokens += event.inputTokens;
      if (event.outputTokens === undefined) bucket.unknownOutput++; else bucket.outputTokens += event.outputTokens;
      if (event.reasoningTokens === undefined) bucket.unknownReasoning++; else bucket.reasoningTokens += event.reasoningTokens;
    }
  }
  if (overflowEvents) await setMeta(tx, 'overflow_events', Number(await getMeta(tx, 'overflow_events') ?? 0) + overflowEvents);
  for (const bucket of grouped.values()) await tx.execute({ sql: aggregateUpsert, args: [bucket.hour, JSON.stringify(bucket.dimensions), JSON.stringify(bucket)] });
}
const sums = ['count', 'durationCount', 'durationSumMs', 'inputTokens', 'outputTokens', 'reasoningTokens', 'unknownInput', 'unknownOutput', 'unknownReasoning'];
const updates = [
  ...sums.map(key => "'$." + key + "',coalesce(json_extract(data,'$." + key + "'),0)+coalesce(json_extract(excluded.data,'$." + key + "'),0)"),
  "'$.durationMaxMs',max(coalesce(json_extract(data,'$.durationMaxMs'),0),coalesce(json_extract(excluded.data,'$.durationMaxMs'),0))",
  ...Array.from({ length: DIAGNOSTIC_LATENCY_BOUNDS_MS.length + 1 }, (_, i) => "'$.durationHistogram[" + i + "]',coalesce(json_extract(data,'$.durationHistogram[" + i + "]'),0)+coalesce(json_extract(excluded.data,'$.durationHistogram[" + i + "]'),0)"),
];
const aggregateUpsert = 'INSERT INTO diagnostic_metric_hours(hour,series,data) VALUES(?,?,?) ON CONFLICT(hour,series) DO UPDATE SET data=json_set(data,' + updates.join(',') + ')';

/** Prune entire hours, so retained hours are never silently partial. */
export async function pruneDiagnosticMetrics(tx: Transaction, now: number) {
  await tx.execute({ sql: 'DELETE FROM diagnostic_metric_hours WHERE hour<?', args: [hour(now - retentionMs)] });
  const overflow = (await tx.execute({ sql: 'SELECT hour FROM diagnostic_metric_hours ORDER BY hour DESC LIMIT 1 OFFSET ?', args: [DIAGNOSTIC_METRIC_MAX_ROWS] })).rows[0];
  if (overflow) await tx.execute({ sql: 'DELETE FROM diagnostic_metric_hours WHERE hour<=?', args: [Number(overflow.hour)] });
  const stale = (await tx.execute({ sql: 'SELECT max(at) AS at FROM diagnostic_metric_seen WHERE at<? OR seq <= (SELECT coalesce(max(seq),0)-? FROM diagnostic_metric_seen)', args: [now - retentionMs, DIAGNOSTIC_METRIC_MAX_SEEN] })).rows[0]?.at;
  if (stale !== null && stale !== undefined) {
    const floor = Math.max(Number(await getMeta(tx, 'deduplication_floor') ?? 0), Number(stale) + 1);
    await setMeta(tx, 'deduplication_floor', floor);
    await tx.execute({ sql: 'DELETE FROM diagnostic_metric_seen WHERE at<?', args: [floor] });
  }
}

function diagnosticLosses(metadata: ReadonlyMap<string, string>) {
  return { persistentDroppedEvents: Number(metadata.get('dropped_events') ?? 0),
    droppedLateEvents: Number(metadata.get('dropped_late_events') ?? 0), overflowEvents: Number(metadata.get('overflow_events') ?? 0) };
}

export async function readDiagnosticLosses(db: Client) {
  const result = await db.execute("SELECT key,value FROM diagnostic_metric_meta WHERE key IN ('dropped_events','dropped_late_events','overflow_events')");
  return diagnosticLosses(new Map(result.rows.map(row => [String(row.key), String(row.value)])));
}

export async function readDiagnosticMetrics(db: Client | undefined, streamId: string | null, options: { since?: number; until?: number }, now: number): Promise<DiagnosticMetrics> {
  const until = options.until ?? now, since = options.since ?? until - 86400000;
  if (!Number.isSafeInteger(since) || !Number.isSafeInteger(until) || since < 0 || since > until || until > now) throw new Error('Invalid diagnostic metrics window');
  const alignedSince = hour(since), alignedUntil = Math.ceil(until / DIAGNOSTIC_METRIC_HOUR_MS) * DIAGNOSTIC_METRIC_HOUR_MS;
  const result: DiagnosticMetrics = { version: 1, streamId, window: { since, until, alignedSince, alignedUntil },
    coverage: { startedAt: null, retainedFrom: null, deduplicationFloor: 0, droppedLateEvents: 0, overflowEvents: 0, available: !!db, droppedEvents: 0, persistentDroppedEvents: 0 },
    ingestionHealth: { enabled: true, available: !!db, queued: 0, droppedEvents: 0 },
    histogram: { upperBoundsMs: DIAGNOSTIC_LATENCY_BOUNDS_MS, overflowBucket: true, cumulative: false }, buckets: [],
    limits: { retentionDays: 30, maxRows: DIAGNOSTIC_METRIC_MAX_ROWS, maxSeriesPerHour: DIAGNOSTIC_METRIC_MAX_SERIES_PER_HOUR, maxSeenEventIds: DIAGNOSTIC_METRIC_MAX_SEEN } };
  if (!db) return result;
  const metadata = new Map((await db.execute('SELECT key,value FROM diagnostic_metric_meta')).rows.map(row => [String(row.key), String(row.value)]));
  result.coverage.startedAt = metadata.has('started_at') ? Number(metadata.get('started_at')) : null;
  result.coverage.deduplicationFloor = Number(metadata.get('deduplication_floor') ?? 0);
  Object.assign(result.coverage, diagnosticLosses(metadata));
  result.coverage.droppedEvents = result.coverage.persistentDroppedEvents;
  const first = (await db.execute('SELECT min(hour) AS hour FROM diagnostic_metric_hours')).rows[0]?.hour;
  result.coverage.retainedFrom = first === null || first === undefined ? null : Number(first);
  const args: InValue[] = [Math.max(alignedSince, hour(now - retentionMs)), until];
  result.buckets = (await db.execute({ sql: 'SELECT data FROM diagnostic_metric_hours WHERE hour>=? AND hour<? ORDER BY hour,series', args })).rows.map(row => {
    const parsed = JSON.parse(String(row.data)) as Partial<DiagnosticMetricBucket>;
    return {
      ...parsed,
      reasoningTokens: typeof parsed.reasoningTokens === 'number' ? parsed.reasoningTokens : 0,
      unknownReasoning: typeof parsed.unknownReasoning === 'number' ? parsed.unknownReasoning : 0
    } as DiagnosticMetricBucket;
  });
  return result;
}
