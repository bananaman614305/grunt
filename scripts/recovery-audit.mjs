import { readFile } from 'node:fs/promises';
import { sanitizeDiagnosticEvent } from '../dist/local/diagnostics.js';
import { buildRecoveryAudit, measureBeatAPI } from '../dist/recovery-audit.js';

const [day, port, exposureFile] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error('Usage: recovery-audit.mjs YYYY-MM-DD loopback-port [verified-beatapi-exposure.json]');
}
process.env.TZ = 'America/New_York';
const start = new Date(day + 'T00:00:00');
const end = new Date(start);
end.setDate(end.getDate() + 1);
const window = { since: start.getTime(), until: end.getTime() };
if (Number.isNaN(window.since) || start.toLocaleDateString('sv-SE') !== day || window.until > Date.now()) {
  throw new Error('Use a completed Eastern calendar day');
}
const origin = 'http://127.0.0.1:' + Number(port) + '/v1/diagnostics/';
const load = async (path, query) => {
  const response = await fetch(origin + path + '?' + new URLSearchParams(query), {
    redirect: 'error', signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Local diagnostics ' + path + ' returned HTTP ' + response.status);
  return response.json();
};
const metrics = await load('metrics', window);
if (!metrics.streamId) throw new Error('No diagnostics stream');
if (!Array.isArray(metrics.adapters)) console.error('Active registry unavailable from this daemon. Tier recommendations require updated diagnostics.');
const events = [];
let after = '0';
for (;;) {
  const page = await load('events', { after, limit: 500, details: '1' });
  if (page.streamId !== metrics.streamId || !Array.isArray(page.events)) throw new Error('Diagnostics stream changed');
  if (!page.events.length) break;
  for (const raw of page.events) {
    const event = sanitizeDiagnosticEvent(raw);
    if (!event?.seq || event.seq <= Number(after)) throw new Error('Invalid diagnostic cursor or event');
    events.push(event);
    after = String(event.seq);
  }
  if (page.nextCursor !== after || events.length > 100_000) throw new Error('Diagnostics pagination exceeded its bounds');
}
let beat;
if (exposureFile) {
  const exposure = JSON.parse(await readFile(exposureFile, 'utf8'));
  const coverage = {};
  for (const key of ['baseline', 'current', 'recovery']) {
    const period = exposure[key];
    if (period) {
      const result = await load('metrics', { since: period.since, until: period.until });
      if (result.streamId !== metrics.streamId) throw new Error('Diagnostics stream changed');
      coverage[key] = result;
    }
  }
  beat = measureBeatAPI(events, exposure, coverage);
}
console.log(JSON.stringify(buildRecoveryAudit(events, window, metrics, beat, metrics.adapters)));
