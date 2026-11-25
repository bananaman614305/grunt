import type { Client } from '@libsql/client';
import type { Registry } from '../registry.js';
import { utcDay } from '../registry-store.js';

const day = 86_400_000;
export const periods = ['day', 'week', 'month', 'all'] as const;
export type Period = typeof periods[number];

export async function adoption(db: Client, registry: Registry, period: Period, now: number) {
  const midnight = Math.floor(now / day) * day;
  const start = period === 'all' ? 0 : midnight - ({ day: 0, week: 6, month: 29 }[period]) * day;
  const range = [start, now + 1];
  const hourlyActivity = `SELECT f.installation,f.hour,f.incomplete,
    MAX(COALESCE(json_extract(s.value,'$.starts') + json_extract(s.value,'$.passed') +
      json_extract(s.value,'$.failed') + json_extract(s.value,'$.cancelled'),0)>0) AS attempted,
    MAX(COALESCE(json_extract(s.value,'$.passed'),0)>0) AS succeeded
    FROM fleet_hours f LEFT JOIN json_each(f.series) s ON true
    WHERE f.hour>=? AND f.hour+3600000<=? GROUP BY f.installation,f.hour`;
  const [active, cohort, collectorUsage, feedback, diagnostics, metering] = await db.batch([
    { sql: `WITH hours AS (${hourlyActivity})
      SELECT COUNT(DISTINCT CASE WHEN attempted THEN installation END) AS active,
      COUNT(DISTINCT installation) AS reporting FROM hours`, args: [start,now] },
    { sql: `WITH hours AS (${hourlyActivity}), first_report AS (
      SELECT installation,MIN(hour) AS joined FROM hours GROUP BY installation
      HAVING MIN(hour)+? BETWEEN ? AND ?),
      progression AS (
        SELECT first_report.installation,joined,MIN(CASE WHEN attempted THEN hour END) AS attempted,
          MIN(CASE WHEN succeeded THEN hour END) AS success,MAX(CASE WHEN succeeded THEN hour END) AS last_success
        FROM first_report JOIN hours USING(installation) WHERE hour<joined+?
        GROUP BY first_report.installation,joined HAVING COUNT(*)=168 AND MAX(incomplete)=0)
      SELECT COUNT(*) AS joined,COUNT(attempted) AS attempted,COUNT(success) AS succeeded,
        COUNT(CASE WHEN last_success/? > success/? THEN 1 END) AS retained FROM progression`,
      args: [0,now,7*day,start,now,7*day,day,day] },
    { sql: `SELECT instance_id AS instance,SUM(input_tokens+output_tokens) AS tokens,
      COUNT(*)-COUNT(input_tokens+output_tokens) AS missing FROM admin_usage_observations
      WHERE at>=? AND at<? GROUP BY instance_id ORDER BY tokens DESC,instance_id`, args: range },
    { sql: `SELECT * FROM registry_daily WHERE day BETWEEN ? AND ?
      UNION ALL SELECT day,id,SUM(ok+failed+quota+auth),SUM(ok),SUM(CASE WHEN ok>0 THEN latency_ms ELSE 0 END),SUM(ok>0)
      FROM registry_feedback WHERE day BETWEEN ? AND ? GROUP BY day,id ORDER BY day,id`,
      args: [utcDay(start),utcDay(now),utcDay(start),utcDay(now)] },
    { sql: `SELECT source,json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.outcome') AS outcome,
      json_extract(payload,'$.model') AS model,json_extract(payload,'$.free') AS free,COUNT(*) AS n FROM admin_events WHERE type='attempt.finish' AND source IS NOT NULL
      AND at>=? AND at<? GROUP BY source,kind,outcome,model,free`, args: range },
    { sql: `WITH replies AS (
        SELECT source,json_extract(payload,'$.durationMs') AS latency,
          json_extract(payload,'$.inputTokens')+json_extract(payload,'$.outputTokens') AS tokens
        FROM admin_events WHERE type='attempt.finish' AND json_extract(payload,'$.kind')='user'
        AND json_extract(payload,'$.outcome')='passed' AND at>=? AND at<?),
      ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY source ORDER BY latency NULLS LAST) AS rank,
        COUNT(latency) OVER(PARTITION BY source) AS samples FROM replies)
      SELECT source,SUM(tokens) AS tokens,MAX(CASE WHEN rank=(95*samples+99)/100 THEN latency END) AS p95
      FROM ranked GROUP BY source`, args: range }
  ], 'read');
  const collectors = collectorUsage!.rows.map(r => ({ instance: String(r.instance),
    tokens: r.tokens === null ? null : Number(r.tokens), missing: Number(r.missing) }));
  const totals = new Map<string, { attempts: number; ok: number; latency: number; samples: number }>();
  const history = new Map<string, Record<string, number>>();
  for (const row of feedback!.rows) {
    const id = String(row.id), date = String(row.day);
    const value = totals.get(id) ?? { attempts: 0, ok: 0, latency: 0, samples: 0 };
    value.attempts += Number(row.attempts);
    value.ok += Number(row.ok);
    value.latency += Number(row.latency_sum);
    value.samples += Number(row.samples);
    totals.set(id, value);
    const bucket = period === 'all' ? date.slice(0,7) : date;
    const counts = history.get(bucket) ?? Object.create(null) as Record<string, number>;
    counts[id] = (counts[id] ?? 0) + Number(row.attempts);
    history.set(bucket, counts);
  }
  const entries = new Map(registry.adapters.map(route => [route.id, route]));
  const ids = new Set([...entries.keys(), ...totals.keys(), ...diagnostics!.rows.map(r => String(r.source))]);
  const routes = [...ids].map(id => {
    const data = totals.get(id), entry = entries.get(id);
    const observations = diagnostics!.rows.filter(r => r.source === id);
    const probes = observations.filter(r => r.kind === 'maintenance' && ['passed','failed'].includes(String(r.outcome)));
    const count = probes.reduce((n,r) => n+Number(r.n),0);
    const billing = observations.filter(r => r.kind === 'user' && r.outcome === 'passed' && r.free !== null);
    const measured = metering!.rows.find(r => r.source === id);
    return { id, tokens: measured?.tokens ?? null, p95: measured?.p95 ?? null, sessionMs: null,
      free: billing.length ? billing.reduce((n,r) => n+(r.free === 1 ? Number(r.n) : 0),0) : null,
      attempts: data?.attempts ?? null, ok: data?.ok ?? null,
      latency: data?.samples ? Math.round(data.latency/data.samples) : null,
      uptime: count ? probes.reduce((n,r) => n+(r.outcome === 'passed' ? Number(r.n) : 0),0)/count : null,
      probes: count, expiry: entry?.expires ?? null, listed: !!entry,
      models: [...new Set(observations.filter(r => r.kind === 'user' && r.outcome === 'passed' && r.model).map(r => String(r.model)))],
      configured: entry?.models ?? (entry?.model ? [entry.model] : []) };
  }).sort((a,b) => (b.attempts ?? -1)-(a.attempts ?? -1) || a.id.localeCompare(b.id));
  return { start, now, published: registry.published, activeInstallations: Number(active!.rows[0]!.active),
    reportingInstallations: Number(active!.rows[0]!.reporting), collectors, cohort: cohort!.rows[0], routes,
    tokens: collectors.some(a => a.tokens !== null) ? collectors.reduce((n,a) => n+(a.tokens ?? 0),0) : null,
    history: [...history].map(([bucket,counts]) => ({ bucket, counts })) };
}
