import type { DiagnosticMetrics } from './diagnostic-metrics.js';
import { gruntEnv } from '../brand.js';
import { installedPort } from './dashboard.js';

export interface EfficiencyCommandDependencies {
  fetcher?: typeof fetch;
  output?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}
/** Aggregate reads only. This command never probes sources or changes scheduling. */
export async function efficiencyCommand(args: string[], dependencies: EfficiencyCommandDependencies = {}) {
  if (args[0] !== 'metrics') throw new Error('Usage: usegrunt efficiency metrics [--port <port>] [--since <epoch-ms>] [--until <epoch-ms>]');
  let port: number | undefined;
  const times: { since?: number; until?: number } = {};
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!, raw = args[i + 1];
    if (!['--port', '--since', '--until'].includes(flag) || seen.has(flag) || !raw || !/^\d+$/.test(raw)) throw new Error('Invalid efficiency argument');
    seen.add(flag); const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid efficiency argument');
    if (flag === '--port') { if (value < 1024 || value > 65535) throw new Error('Invalid efficiency port'); port = value; }
    else times[flag === '--since' ? 'since' : 'until'] = value;
  }
  if (times.since !== undefined && times.until !== undefined && times.since > times.until) throw new Error('Invalid efficiency window');
  if (port === undefined) {
    const env = dependencies.env ?? process.env;
    const text = gruntEnv('PORT', env) ?? String(await installedPort(env));
    port = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid efficiency port');
  }
  const url = new URL(`http://127.0.0.1:${port}/v1/diagnostics/metrics`);
  for (const [key, value] of Object.entries(times)) url.searchParams.set(key, String(value));
  const response = await (dependencies.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Local efficiency measurements are unavailable'); }
  // Bound response reading as well as the request; no content from provider errors is printed.
  if (!response.body) throw new Error('Invalid efficiency report');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('Efficiency report exceeds the bounded output size');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const report = JSON.parse(Buffer.concat(chunks).toString('utf8')) as DiagnosticMetrics;
  if (report.version !== 1 || !Array.isArray(report.buckets) || report.coverage?.available !== true) throw new Error('Invalid efficiency report');
  (dependencies.output ?? console.log)(JSON.stringify(report, null, 2));
  return report;
}
