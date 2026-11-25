import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Client } from '@libsql/client';
import { bundledRegistry, knownAdapters } from './registry.js';
import type { DiagnosticMetrics } from './local/diagnostic-metrics.js';

export const HOUR = 3600000;
export const DAY = 24 * HOUR;
const routes = new Set([...knownAdapters, ...bundledRegistry.adapters.map(a => a.id)]);
const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
interface Series {
  route: string; release: string; starts: number; passed: number; failed: number;
  cancelled: number; timed: number; slow: number; timeout: number; quota: number;
}
export interface FleetHour { hour: number; incomplete: boolean; series: Series[] }

export function fleetHour(hour: number, metrics: DiagnosticMetrics, lossDuringWindow: boolean): FleetHour {
  const series = new Map<string, Series>();
  const slowBucket = metrics.histogram.upperBoundsMs.indexOf(10000);
  let incomplete = lossDuringWindow
    || (metrics.coverage.startedAt ?? Infinity) > hour;
  for (const b of metrics.buckets) {
    const d = b.dimensions;
    if (d.type === 'overflow') incomplete = true;
    if (d.kind !== 'user' || !d.source || !routes.has(d.source) || !['attempt.start','attempt.finish'].includes(d.type)) continue;
    const release = versionPattern.test(d.runtimeVersion ?? '') ? d.runtimeVersion! : 'unknown';
    const key = release + '/' + d.source;
    const row = series.get(key) ?? { route: d.source, release, starts: 0, passed: 0, failed: 0, cancelled: 0, timed: 0, slow: 0, timeout: 0, quota: 0 };
    if (d.type === 'attempt.start') row.starts += b.count;
    else if (d.outcome === 'passed') {
      row.passed += b.count;
      row.timed += b.durationCount;
      row.slow += b.durationHistogram.slice(slowBucket + 1).reduce((a, n) => a + n, 0);
    } else if (d.outcome === 'failed') {
      row.failed += b.count;
      if (d.errorCode === 'timeout' || d.errorCode === 'quota') row[d.errorCode] += b.count;
    }
    else if (d.outcome === 'cancelled') row.cancelled += b.count;
    series.set(key, row);
  }
  return { hour, incomplete, series: [...series.values()] };
}

export function validHour(input: unknown, now: number): input is FleetHour {
  const h = input as FleetHour | null;
  if (!h || Object.keys(h).sort().join() !== 'hour,incomplete,series' || !Number.isSafeInteger(h.hour)
    || h.hour % HOUR || h.hour < Math.floor(now/HOUR)*HOUR - 7*DAY || h.hour + HOUR > now
    || typeof h.incomplete !== 'boolean' || !Array.isArray(h.series) || h.series.length > 256) return false;
  const seen = new Set<string>();
  return h.series.every(s => {
    if (!s || Object.keys(s).sort().join() !== 'cancelled,failed,passed,quota,release,route,slow,starts,timed,timeout'
      || !routes.has(s.route) || typeof s.release !== 'string' || !(s.release === 'unknown' || versionPattern.test(s.release))
      || ![s.starts,s.passed,s.failed,s.cancelled,s.timed,s.slow,s.timeout,s.quota].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000000)
      || s.timeout + s.quota > s.failed || s.slow > s.timed || s.timed > s.passed) return false;
    const key = s.route + '/' + s.release;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The gateway issues scoped installation tokens on the existing HTTPS feedback
// exchange. The principal is the digest of a private installation proof.
export function fleetToken(install: string, secret: string) {
  const signature = createHmac('sha256',secret).update('grunt-fleet-v1:' + install).digest('hex');
  return install + '.' + signature;
}
export function fleetPrincipal(token: string, secret: string | undefined) {
  if (!secret || secret.length < 32 || !/^[0-9a-f]{64}\.[0-9a-f]{64}$/.test(token)) return;
  const install = token.slice(0,64);
  if (timingSafeEqual(Buffer.from(token),Buffer.from(fleetToken(install,secret)))) return install;
}

export const fleetSchema = 'CREATE TABLE IF NOT EXISTS fleet_hours(hour INTEGER, installation TEXT, incomplete INTEGER, series TEXT NOT NULL, PRIMARY KEY(hour,installation));';
export async function saveHour(db: Client, installation: string, h: FleetHour, now: number) {
  await db.batch([
    { sql: 'INSERT OR REPLACE INTO fleet_hours VALUES(?,?,?,?)', args: [h.hour, installation, Number(h.incomplete), JSON.stringify(h.series)] },
    { sql: 'DELETE FROM fleet_hours WHERE hour < ?', args: [now - 30 * DAY] }
  ], 'write');
}

export async function fleetAudit(db: Client, end: number) {
  const start = end - DAY, since = start - 7*DAY;
  const totals = await db.execute({ sql: `SELECT count(DISTINCT installation) installs, count(*) hours,
    coalesce(sum(incomplete),0) partial FROM fleet_hours WHERE hour>=? AND hour<?`, args: [start,end] });
  const rows = await db.execute({ sql: `WITH expanded AS (
    SELECT hour,hour>=? AS current, installation, incomplete, value AS s FROM fleet_hours,json_each(series) WHERE hour>=? AND hour<?
  ), per_install AS (
    SELECT installation,json_extract(s,'$.release') release,json_extract(s,'$.route') route,current,
      sum(json_extract(s,'$.passed')+json_extract(s,'$.failed')) terminal,sum(json_extract(s,'$.failed')) failed,
      sum(json_extract(s,'$.timed')) timed,sum(json_extract(s,'$.slow')) slow
    FROM expanded GROUP BY installation,release,route,current
  ), expected AS (
    SELECT today.release,today.route,
      CASE WHEN sum(today.terminal>0 AND prior.terminal=0)=0 THEN
        sum(today.terminal * 1.0 * prior.failed / nullif(prior.terminal,0)) END expectedFailed,
      CASE WHEN sum(today.timed>0 AND prior.timed=0)=0 THEN
        sum(today.timed * 1.0 * prior.slow / nullif(prior.timed,0)) END expectedSlow
    FROM per_install today JOIN per_install prior USING(installation,release,route)
    WHERE today.current=1 AND prior.current=0 GROUP BY today.release,today.route
  ), matched AS (
    SELECT installation,release,route FROM per_install GROUP BY installation,release,route HAVING count(*)=2
  ) SELECT current, json_extract(s,'$.release') release,json_extract(s,'$.route') route,
    expected.expectedFailed,expected.expectedSlow,count(DISTINCT expanded.installation) installs,
    count(DISTINCT matched.installation) comparable,count(DISTINCT hour) observedHours,count(DISTINCT hour/86400000) days,sum(incomplete) partial,
    count(DISTINCT CASE WHEN json_extract(s,'$.failed')>0 THEN expanded.installation END) failingInstalls,
    count(DISTINCT CASE WHEN json_extract(s,'$.slow')>0 THEN expanded.installation END) slowInstalls,
    sum(json_extract(s,'$.starts')) starts,sum(json_extract(s,'$.passed')) passed,sum(json_extract(s,'$.failed')) failed,
    sum(json_extract(s,'$.timeout')) timeout,sum(json_extract(s,'$.quota')) quota,
    sum(json_extract(s,'$.cancelled')) cancelled,sum(json_extract(s,'$.slow')) slow,sum(json_extract(s,'$.timed')) timed
    FROM expanded LEFT JOIN matched ON expanded.installation=matched.installation
      AND json_extract(s,'$.release')=matched.release AND json_extract(s,'$.route')=matched.route
    LEFT JOIN expected ON expected.release=json_extract(s,'$.release') AND expected.route=json_extract(s,'$.route')
    GROUP BY current,json_extract(s,'$.release'),json_extract(s,'$.route') ORDER BY release,route`, args: [start,since,end] });
  const findings = [];
  for (const row of rows.rows.filter(r => r.current === 1)) {
    const base = rows.rows.find(r => r.current === 0 && r.release === row.release && r.route === row.route);
    if (!base || row.release === 'unknown' || row.partial || base.partial || row.comparable !== row.installs || base.comparable !== base.installs
      || Number(row.observedHours)<6 || Number(base.observedHours)<12 || Number(row.installs)<2 || Number(base.installs)<2 || Number(base.days)<2) continue;
    for (const kind of ['failed','slow'] as const) {
      const denominator = (r: typeof row) => kind === 'failed' ? Number(r.passed)+Number(r.failed) : Number(r.timed);
      const n = denominator(row), b = denominator(base);
      const expected = kind === 'failed' ? row.expectedFailed : row.expectedSlow;
      if (expected == null || !n) continue;
      // Apply today's installation shares to both windows. Missing historical
      // denominators leave the comparison unknown for that metric.
      const rate = Number(row[kind]) / n, prior = Number(expected) / n;
      if (Number(kind === 'slow' ? row.slowInstalls : row.failingInstalls) < 2 || n<20 || b<40 || Number(row[kind])<5 || rate-prior<0.1 || rate<2*prior) continue;
      findings.push({ handle: 'fleet-'+row.route+'-'+kind, route: row.route, release: row.release, kind,
        affected: Number(row[kind]), denominator: n, baselineAffected: Number(base[kind]), baselineDenominator: b,
        rate, standardizedBaselineRate: prior, excess: Math.round(Number(row[kind]) - Number(expected)), confidence: 'Observed on multiple installations in a matched release and route cohort.',
        fix: kind === 'slow' ? 'Instrument time to first output on this adapter and isolate the wait before the first successful chunk.'
          : Number(row.timeout) > Number(row.failed)/2 ? 'Check the adapter timeout against first-output timing and repair the stalled wait.'
          : Number(row.quota) > Number(row.failed)/2 ? 'Compare quota failures with retry-after handling and correct the route cooldown.'
          : 'Group failed traces by adapter stage and reproduce the dominant error before changing retry behavior.',
        verification: 'Replay the affected route and compare the same rate in the next complete UTC window.' });
    }
  }
  findings.sort((a,b) => b.excess-a.excess || a.handle.localeCompare(b.handle));
  return { start,end,baselineStart:since,coverage:totals.rows[0], cohorts:rows.rows,findings,
    defaultHandle: findings[0]?.handle ?? null };
}
