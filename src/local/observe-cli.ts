import { parseArgs } from 'node:util';
import { gruntEnv } from '../brand.js';
import { installedPort } from './dashboard.js';
import { OBSERVATION_LIMIT, OBSERVATION_PATH, observationLimit } from './observe.js';
import type { Observation } from './observe.js';

const help = `Usage: usegrunt observe [--limit <N>] [--json] [--port <port>]

Show all in-flight requests, recent completions, route health, and daemon configuration.
--limit <N>  Number of completed requests to include (default ${OBSERVATION_LIMIT}, 0 for live only)
--json       Print the JSON from GET ${OBSERVATION_PATH}?limit=<N>
--port       Use a specific local daemon port

Prompt and response text lengths are reported in bytes. Account labels identify
the access method (for example, a local session or vault grant).
Clients may send X-Grunt-Caller with a short non-secret agent label.`;

const time = (at: number | null) => at === null ? '?' : new Date(at).toISOString();
const ms = (duration: number | null) => duration === null ? '?' : `${Math.round(duration)} ms`;

function render(report: Observation) {
  const { daemon, diagnostics } = report;
  const lines = [`Grunt ${daemon.version ?? 'unknown version'} · ${daemon.readiness} · uptime ${ms(daemon.uptimeMs)} · ${time(report.observedAt)}`,
    `  ${daemon.config.host}:${daemon.config.port} · ${daemon.config.routing} · first-output default ${ms(daemon.config.defaultFirstOutputMs)}`,
    `  History ${diagnostics.historyAvailable ? 'available' : 'unavailable'} · diagnostic writes queued ${diagnostics.health?.queued ?? '?'} · events dropped in this process ${diagnostics.health?.droppedEvents ?? '?'}`];
  if (diagnostics.losses) {
    lines.push(`  Journal drops ${diagnostics.losses.persistentDroppedEvents ?? '?'} · late ${diagnostics.losses.droppedLateEvents ?? '?'} · metric overflow ${diagnostics.losses.overflowEvents ?? '?'}`);
  }
  for (const [label, requests] of [['In flight', report.inFlight], ['Completed', report.completed]] as const) {
    lines.push('', `${label} (${requests.length})`);
    for (const request of requests) {
      lines.push(`  ${request.id} · ${request.caller ?? request.actor ?? request.kind} · ${request.model ?? '?'} → ${request.selectedRoute ?? '?'} · ${request.state ?? '?'} for ${ms(request.stateDurationMs)}`,
        `    Started ${time(request.startedAt)} · ended ${time(request.endedAt)} · elapsed ${ms(request.durationMs)} · queue position ${request.queuePosition ?? '?'}`,
        `    Prompt ${request.promptBytes ?? '?'} bytes · response ${request.responseBytes ?? '?'} bytes · requested output limit ${request.maxOutputTokens ?? '?'}`);
      if (request.errorText) lines.push(`    ${request.errorText}`);
      for (const attempt of request.attempts) {
        lines.push(`    ${attempt.provider ?? '?'} / ${attempt.model ?? '?'} (${attempt.account ?? 'account unknown'}) · ${attempt.outcome ?? 'active'}`,
          `      Started ${time(attempt.startedAt)} · first token ${time(attempt.firstTokenAt)} · latest output ${time(attempt.lastProgressAt)} · ended ${time(attempt.endedAt)}`,
          `      Provider finish ${attempt.providerFinishReason ?? '?'} · output limit ${attempt.maxOutputTokens ?? '?'} · tokens in ${attempt.tokens.input ?? '?'}, out ${attempt.tokens.output ?? '?'}, reasoning ${attempt.tokens.reasoning ?? '?'}`);
        if (attempt.errorText) lines.push(`      ${attempt.errorText}`);
        for (const dispatch of attempt.dispatches) lines.push(`      Dispatch ${time(dispatch.at)} · ${dispatch.model ?? '?'} (${dispatch.account ?? '?'})`);
        for (const transport of attempt.transport) {
          lines.push(`      ${time(transport.at)} · ${transport.type ?? '?'} ${transport.endpoint ?? ''} ${transport.status ?? ''} · ${ms(transport.durationMs)}${transport.errorText ? ` · ${transport.errorText}` : ''}`);
        }
      }
      for (const decision of request.routeDecisions) lines.push(`    ${time(decision.at)} · ${decision.route} ${decision.decision}${decision.reason ? ` (${decision.reason})` : ''}`);
    }
  }
  lines.push('', 'Routes');
  for (const route of report.routes) {
    const cooldown = route.cooldown ? ` · cooldown ${route.cooldown.until === null ? 'indefinite' : `until ${time(route.cooldown.until)}`}` : '';
    const quota = route.quotaWindow?.resetAt ?? route.scheduledQuotaRefillAt;
    lines.push(`  ${route.id} · ${route.state} · ${route.active} active${route.errorCode ? ` · ${route.errorCode}` : ''}${cooldown}${quota === undefined ? '' : ` · quota resets ${time(quota)}`}`);
  }
  return lines.join('\n');
}

export async function observeCommand(args: string[], dependencies: { env?: NodeJS.ProcessEnv; fetcher?: typeof fetch; output?: (text: string) => void } = {}) {
  const { values } = parseArgs({ args, options: { limit: { type: 'string' }, json: { type: 'boolean' },
    port: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const output = dependencies.output ?? console.log;
  if (values.help) { output(help); return; }
  const limit = observationLimit(values.limit), env = dependencies.env ?? process.env;
  const port = values.port ?? gruntEnv('PORT', env) ?? String(await installedPort(env));
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid observation port');
  const url = new URL(`http://127.0.0.1:${Number(port)}${OBSERVATION_PATH}?limit=${limit}`);
  const response = await (dependencies.fetcher ?? fetch)(url, { redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Local Grunt observation is unavailable'); }
  const report = await response.json() as Observation;
  if (report.version !== 1 || !Array.isArray(report.inFlight) || !Array.isArray(report.completed) || !Array.isArray(report.routes)) {
    throw new Error('Invalid local Grunt observation');
  }
  output(values.json ? JSON.stringify(report, null, 2) : render(report));
}
