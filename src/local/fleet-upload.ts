import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DAY, fleetHour, HOUR } from '../fleet.js';
import type { DiagnosticsStore } from './diagnostics.js';

export async function uploadFleet(store: DiagnosticsStore, directory: string, urls: readonly string[], token: string, now = Date.now(), fetcher = fetch, adoptionConsent = false) {
  const end = Math.floor(now / HOUR)*HOUR;
  const meta = await store.metrics({ since: end, until: end });
  if (!meta.coverage.available || !meta.coverage.startedAt || !meta.streamId) return;

  const checkpoint = join(directory,'fleet-hour-cursor');
  let start = Math.max(end-7*DAY, Math.floor(meta.coverage.startedAt/HOUR)*HOUR);
  const loss = meta.coverage.droppedEvents + meta.coverage.droppedLateEvents;
  let acknowledgedLoss = 0;
  try {
    const saved = JSON.parse(await readFile(checkpoint,'utf8'));
    if (saved.stream === meta.streamId && Number.isSafeInteger(saved.next) && saved.next <= end && saved.next % HOUR === 0) {
      start = Math.max(start, saved.next);
      if (Number.isSafeInteger(saved.loss)) acknowledgedLoss = saved.loss;
    }
  } catch { /* Replaying retained hours replaces prior snapshots. */ }
  const saveCursor = async (next: number, loss: number) => {
    const tmp = checkpoint + '.' + randomUUID();
    try {
      await writeFile(tmp, JSON.stringify({ stream: meta.streamId, next, loss }), { mode: 0o600 });
      await rename(tmp, checkpoint);
    } finally { await rm(tmp, { force: true }); }
  };
  for (let hour=start; hour<end; hour+=HOUR) {
    const metrics = await store.metrics({ since: hour, until: hour+HOUR });
    if (!metrics.coverage.available) return;
    // A dormant daemon can resume days later. Empty journal hours give no
    // evidence that it was running during that interval.
    if (!metrics.buckets.length) {
      if (hour + HOUR === end) await saveCursor(end, loss);
      continue;
    }
    const body = JSON.stringify(fleetHour(hour, metrics, loss > acknowledgedLoss));
    let acknowledged = false;
    for (const url of urls) {
      try {
        const response = await fetcher(url + '/fleet', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(adoptionConsent ? { 'X-Grunt-Adoption-Consent': '1' } : {}) }, body });
        await response.body?.cancel();
        if (response.status === 204) { acknowledged = true; break; }
      } catch { /* A mirror may still be available. */ }
    }
    if (!acknowledged) return;
    await saveCursor(hour + HOUR, hour + HOUR === end ? loss : acknowledgedLoss);
  }
}
