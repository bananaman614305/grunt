// Preserve captured absolute cooldowns only. No probes, samples or provider selection.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const [runtime, directory, input] = process.argv.slice(2);
const { RoutingHistory } = await import(pathToFileURL(resolve(runtime, 'dist/local/routing-history.js')).href);
const { SourceError } = await import(pathToFileURL(resolve(runtime, 'dist/local/source.js')).href);
const captured = JSON.parse(await readFile(input, 'utf8'));
const now = Date.now(), codes = new Set(['quota', 'upstream', 'timeout', 'refused']);
if (!Array.isArray(captured.windows) || captured.windows.length > 100) throw Error('Invalid captured windows');
const seen = new Set();
for (const row of captured.windows) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(row.id) || seen.has(row.id) || !codes.has(row.code)
    || !Number.isFinite(row.retryAt) || row.retryAt < 0 || row.retryAt - now > 32 * 86400000) throw Error('Invalid captured cooldown');
  seen.add(row.id);
}
const history = await RoutingHistory.open(directory);
try {
  const before = await history.snapshot(now), receipts = [];
  for (const row of captured.windows) {
    if (row.retryAt <= now) { receipts.push({ id: row.id, capturedUntil: row.retryAt, expired: true }); continue; }
    const previous = before.backoff.find(entry => entry.source === row.id)?.value;
    if (previous?.until >= row.retryAt && (row.code !== 'quota' || previous.code === 'quota')) {
      receipts.push({ id: row.id, code: previous.code, capturedUntil: row.retryAt, until: previous.until, preservedExisting: true }); continue;
    }
    // Ceil only the binary floating conversion if it would shorten the deadline.
    const until = Math.max(row.retryAt, previous?.until ?? 0);
    const code = row.code === 'quota' || previous?.code === 'quota' && previous.until > now ? 'quota' : row.code;
    let seconds = (until - now) / 1000;
    if (now + seconds * 1000 < until) seconds = Math.ceil(seconds * 1000) / 1000;
    const value = await history.failure(row.id, new SourceError(code, 'Preserved runtime cooldown'), seconds, false, now);
    if (value.until < until || value.until > until + 1 || code === 'quota' && value.code !== 'quota') throw Error('Cooldown preservation mismatch');
    receipts.push({ id: row.id, code: value.code, capturedUntil: row.retryAt, until: value.until, preservedExisting: false });
  }
  const after = await history.snapshot(now);
  if (JSON.stringify(before.performance) !== JSON.stringify(after.performance)) throw Error('Preservation must not change performance samples');
  await history.flush();
  console.log(JSON.stringify({ at: now, windows: receipts, performanceUnchanged: true, providerCalls: 0 }));
} finally { await history.close(); }
