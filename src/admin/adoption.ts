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
  const [active, cohort, feedback, diagnostics, sessions, metering] = await db.batch([
    { sql: `WITH attempts AS (
      SELECT account,measured_tokens,device,country,
        ROW_NUMBER() OVER(PARTITION BY account ORDER BY ts DESC,call_id DESC) AS recency
      FROM account_attempts JOIN calls ON calls.rowid=call_id WHERE ts>=? AND ts<?)
      SELECT account,SUM(measured_tokens) AS tokens,COUNT(*)-COUNT(measured_tokens) AS missing,
        MAX(CASE WHEN recency=1 THEN device END) AS device,MAX(CASE WHEN recency=1 THEN country END) AS country
      FROM attempts GROUP BY account ORDER BY tokens DESC,account`, args: range },
    { sql: `WITH first_use AS (
      SELECT person,MIN(ts) AS joined FROM messages WHERE role='user' GROUP BY person
      HAVING joined>=MAX(?,(SELECT MIN(started_at) FROM account_metering)) AND joined<?),
      progression AS (
        SELECT person,joined,MIN(c.ts) AS attempted,MIN(CASE WHEN c.outcome='ok' THEN c.ts END) AS success
        FROM first_use LEFT JOIN account_attempts a ON a.account=person
        LEFT JOIN calls c ON c.rowid=a.call_id AND c.ts>=joined AND c.ts<joined+?
        GROUP BY person,joined)
      SELECT COUNT(*) AS joined,COUNT(attempted) AS attempted,COUNT(success) AS succeeded,
        COUNT(CASE WHEN EXISTS (SELECT 1 FROM account_attempts a JOIN calls c ON c.rowid=a.call_id
          WHERE a.account=person AND c.outcome='ok' AND c.ts/? > success/? AND c.ts<joined+?) THEN 1 END) AS retained
      FROM progression`, args: [Math.max(0,start-7*day),now+1-7*day,7*day,day,day,7*day] },
    { sql: `SELECT * FROM registry_daily WHERE day BETWEEN ? AND ?
      UNION ALL SELECT day,id,SUM(ok+failed+quota+auth),SUM(ok),SUM(CASE WHEN ok>0 THEN latency_ms ELSE 0 END),SUM(ok>0)
      FROM registry_feedback WHERE day BETWEEN ? AND ? GROUP BY day,id ORDER BY day,id`,
      args: [utcDay(start),utcDay(now),utcDay(start),utcDay(now)] },
    { sql: `SELECT source,json_extract(payload,'$.kind') AS kind,json_extract(payload,'$.outcome') AS outcome,
      json_extract(payload,'$.model') AS model,json_extract(payload,'$.free') AS free,COUNT(*) AS n FROM admin_events WHERE type='attempt.finish' AND source IS NOT NULL
      AND at>=? AND at<? GROUP BY source,kind,outcome,model,free`, args: range },
    { sql: `WITH runs AS (
        SELECT source,instance_id,id,at,MAX(?,at-json_extract(payload,'$.durationMs')) AS began
        FROM admin_events WHERE type='attempt.finish' AND json_extract(payload,'$.kind')='user'
        AND json_extract(payload,'$.durationMs') IS NOT NULL AND at>=? AND at<?),
      gaps AS (SELECT *,MAX(at) OVER (PARTITION BY instance_id,source ORDER BY began,id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous FROM runs),
      numbered AS (SELECT *,SUM(CASE WHEN previous IS NULL OR began-previous>1800000 THEN 1 ELSE 0 END)
        OVER (PARTITION BY instance_id,source ORDER BY began,id) AS series FROM gaps),
      spans AS (SELECT source,MAX(at)-MIN(began) AS duration FROM numbered GROUP BY instance_id,source,series)
      SELECT source,AVG(duration) AS duration FROM spans GROUP BY source`, args: [start,...range] },
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
  const accounts = active!.rows.map(r => ({ account: String(r.account), tokens: r.tokens === null ? null : Number(r.tokens),
    missing: Number(r.missing), device: String(r.device), country: String(r.country) }));
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
    const session = sessions!.rows.find(r => r.source === id);
    const measured = metering!.rows.find(r => r.source === id);
    return { id, tokens: measured?.tokens ?? null, p95: measured?.p95 ?? null, sessionMs: session ? Math.round(Number(session.duration)) : null,
      free: billing.length ? billing.reduce((n,r) => n+(r.free === 1 ? Number(r.n) : 0),0) : null,
      attempts: data?.attempts ?? null, ok: data?.ok ?? null,
      latency: data?.samples ? Math.round(data.latency/data.samples) : null,
      uptime: count ? probes.reduce((n,r) => n+(r.outcome === 'passed' ? Number(r.n) : 0),0)/count : null,
      probes: count, expiry: entry?.expires ?? null, listed: !!entry,
      models: [...new Set(observations.filter(r => r.kind === 'user' && r.outcome === 'passed' && r.model).map(r => String(r.model)))],
      configured: entry?.models ?? (entry?.model ? [entry.model] : []) };
  }).sort((a,b) => (b.attempts ?? -1)-(a.attempts ?? -1) || a.id.localeCompare(b.id));
  return { start, now, published: registry.published, accounts, cohort: cohort!.rows[0], routes,
    tokens: accounts.some(a => a.tokens !== null) ? accounts.reduce((n,a) => n+(a.tokens ?? 0),0) : null,
    history: [...history].map(([bucket,counts]) => ({ bucket, counts })) };
}
