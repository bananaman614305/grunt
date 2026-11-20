import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentWorkerBatches } from './worker-agent-client.js';
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-agent-client-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
function fixture(run?: (request: RequestInit) => Promise<Response>) {
  const challengeId = randomUUID(), fileName = `.grunt-workspace-${randomUUID()}.proof`, token = 'a'.repeat(64), nonce = 'b'.repeat(64), jobId = randomUUID();
  const artifact = { id: randomUUID(), complete: true, truncated: false, files: [] };
  const requests: { path: string; request: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, request: RequestInit = {}) => {
    const path = String(url).split('/v1/workers')[1]!; requests.push({ path, request });
    if (path === '/projects/challenge') { expect(JSON.parse(String(request.body))).toEqual({ projectRoot: directory }); return Response.json({ challengeId, fileName, nonce }); }
    if (path === '/projects/register') {
      expect(await readFile(join(directory, fileName), 'utf8')).toBe(nonce);
      expect((await stat(join(directory, fileName))).mode & 0o777).toBe(0o600);
      await rm(join(directory, fileName));
      return Response.json({ token, expiresAt: Date.now() + 86400000 });
    }
    if (path === '/capabilities') return Response.json({ filesystem: true, commands: true, sandbox: 'bubblewrap', initialSnapshotRequired: false });
    expect(new Headers(request.headers).get('Authorization')).toBe(`Bearer ${token}`);
    if (path === '/run') return run ? run(request) : Response.json({ ok: true, id: jobId, source: 'kilo', text: 'Complete', artifact });
    if (path === '/retained') return Response.json({ retained: [{ id: jobId }] });
    if (path === `/artifacts/${jobId}`) return Response.json({ artifact, ownedPaths: ['src'] });
    if (path.endsWith('/discard') || path === '/projects/revoke') return Response.json({ ok: true });
    throw new Error('Unexpected request');
  }) as unknown as typeof fetch;
  return { client: new AgentWorkerBatches(8793, directory, fetcher), requests, fetcher, token, jobId, artifact };
}
it('authorizes through a private caller-written proof and hides the capability from output', async () => {
  const { client, requests, token, artifact } = fixture();
  const started = await client.start({ tasks: [{ task: 'Edit one module', ownedPaths: ['src/a.ts'] }] });
  const result = await client.wait({ batchId: started.batchId }, new AbortController().signal);
  expect(result.results?.[0]).toMatchObject({ ok: true, artifact });
  expect(JSON.stringify(result)).not.toContain(token);
  expect(requests.find(item => item.path === '/run')?.request.body).toBe(JSON.stringify({ task: 'Edit one module', mode: 'agent', ownedPaths: ['src/a.ts'] }));
  await client.close(); expect(requests.at(-1)?.path).toBe('/projects/revoke');
});
it('rejects a model-selected project or runner before any authorization request', async () => {
  const { client, fetcher } = fixture();
  await expect(client.start({ tasks: [{ task: 'Edit', ownedPaths: ['src'], projectRoot: '/tmp/other' }] })).rejects.toThrow('cannot select');
  await expect(client.start({ tasks: [{ task: 'Edit', ownedPaths: ['../outside'] }] })).rejects.toThrow('relative');
  expect(fetcher).not.toHaveBeenCalled(); await client.close();
});
it('reuses a lease and retains partial work when a batch is cancelled', async () => {
  const { client, requests } = fixture(request => new Promise((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
  const first = await client.start({ tasks: [{ task: 'Edit', ownedPaths: ['src/a'] }] });
  const second = await client.start({ tasks: [{ task: 'Review', ownedPaths: ['src/b'] }] });
  expect(client.cancel({ batchId: first.batchId })).toEqual({ batchId: first.batchId, state: 'cancelled', artifactsRetained: true });
  client.cancel({ batchId: second.batchId }); await client.close();
  expect(requests.filter(item => item.path === '/projects/register')).toHaveLength(1);
  expect(requests.at(-1)?.path).toBe('/projects/revoke');
});
it('recovers artifact ownership from the original server record', async () => {
  const { client, jobId, artifact } = fixture();
  expect(await client.artifact(jobId)).toEqual({ artifact, ownedPaths: ['src'] });
  await client.discard(jobId); await client.close();
});
it('fails closed when an old server omits original task ownership', async () => {
  const base = fixture();
  const fetcher = vi.fn(async (url: string | URL | Request, request?: RequestInit) => String(url).includes('/artifacts/') ? Response.json({ artifact: base.artifact }) : base.fetcher(url, request));
  const client = new AgentWorkerBatches(8793, directory, fetcher as typeof fetch);
  await expect(client.apply(base.jobId)).rejects.toThrow('Missing original worker ownership');
  await client.close();
});
it('preserves a preexisting proof path instead of clobbering it', async () => {
  const fileName = `.grunt-workspace-${randomUUID()}.proof`;
  await writeFile(join(directory, fileName), 'existing');
  const fetcher = vi.fn(async () => Response.json({ challengeId: randomUUID(), fileName, nonce: 'b'.repeat(64) }));
  const client = new AgentWorkerBatches(8793, directory, fetcher as typeof fetch);
  await expect(client.retained()).rejects.toThrow();
  expect(await readFile(join(directory, fileName), 'utf8')).toBe('existing'); await client.close();
});
