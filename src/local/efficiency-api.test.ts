import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { DiagnosticsStore } from './diagnostics.js';
import { Sources } from './source.js';

test('durable metrics use protected loopback reads and never probe a provider', async () => {
  const path = await mkdtemp(join(tmpdir(), 'grunt-efficiency-api-'));
  const store = await DiagnosticsStore.open({ directory: path, runtimeVersion: '0.9.6' });
  const provider = { id: 'fixture', available: vi.fn(async () => true), complete: vi.fn(async () => ({ text: 'unused' })) };
  const sources = new Sources([provider]); sources.setDiagnostics(store);
  const app = createLocalApp(sources);
  try {
    store.record({ version: 1, id: randomUUID(), requestId: randomUUID(), at: Date.now(), type: 'request.finish', kind: 'user', actor: 'client', outcome: 'passed', durationMs: 42 });
    const url = 'http://127.0.0.1:8788/v1/diagnostics/metrics';
    const response = await app.request(url);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const report = await response.json();
    expect(report.buckets.some((bucket: { dimensions: { type: string }; count: number }) => bucket.dimensions.type === 'request.finish' && bucket.count === 1)).toBe(true);
    expect((await app.request('http://attacker.invalid:8788/v1/diagnostics/metrics')).status).toBe(403);
    expect((await app.request(url, { headers: { origin: 'https://attacker.invalid' } })).status).toBe(403);
    expect((await app.request(url + '?since=NaN')).status).toBe(400);
    expect((await app.request(url + '?since=200&until=100')).status).toBe(400);
    expect(provider.available).not.toHaveBeenCalled(); expect(provider.complete).not.toHaveBeenCalled();
    await store.close(); expect((await app.request(url)).status).toBe(503);
  } finally { await store.close(); await rm(path, { recursive: true, force: true }); }
});
