import { expect, it } from 'vitest';
import { createLocalApp } from './api.js';
import { Sources } from './source.js';
import gruntExecutionExtension from './execution-pi.js';
import legacyEntry from './worker-pi.js';

const sources = () => new Sources([{ id: 'kilo', available: async () => true, complete: async () => ({ text: 'ok' }) }]);
const base = 'http://127.0.0.1:8788';
const json = { 'Content-Type': 'application/json' };

it('answers every removed /v1/workers route with a clear 410 in the old failure shape instead of failing', async () => {
  const pool = sources(), app = createLocalApp(pool);
  try {
    for (const [method, path] of [['GET', '/v1/workers'], ['GET', '/v1/workers/capabilities'], ['GET', '/v1/workers/retained'], ['GET', '/v1/workers/artifacts/x'],
      ['POST', '/v1/workers/run'], ['POST', '/v1/workers/projects/challenge'], ['POST', '/v1/workers/artifacts/x/discard']] as const) {
      const response = await app.request(base + path, { method, headers: json, ...(method === 'POST' ? { body: '{"task":"old client"}' } : {}) });
      expect(response.status, path).toBe(410);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.json();
      // An old extension reads `ok:false` and a known failure code, then reports the message.
      expect(body).toMatchObject({ ok: false, code: 'unavailable', error: { type: 'removed', message: expect.stringContaining('subworkers were removed') } });
    }
    expect(await (await app.request(base + '/v1/status')).json()).not.toHaveProperty('workers');
    expect((await app.request(base + '/v1/models')).status).toBe(200);
    expect((await app.request(base + '/v1/workers', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
  } finally { await pool.close(); }
});

it('keeps the Pi extension loadable from old launch commands and ignores the removed subworker flags', () => {
  const flags: string[] = [];
  const pi = { registerFlag: (name: string) => { flags.push(name); }, getFlag: () => true, registerTool: () => {},
    exec: (async () => ({ stdout: '', stderr: '', code: 0, killed: false })) as never, on: (() => {}) as never };
  gruntExecutionExtension(pi);
  expect(flags).toEqual(expect.arrayContaining(['grunt-agent-workers', 'grunt-worker-port', 'grunt-background-jobs', 'grunt-checkpoints']));
  expect(legacyEntry).toBe(gruntExecutionExtension);
});
