import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentWorkerBatches, workerResultView } from './worker-agent-client.js';
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

it('bounds tool result context and omits all retained file contents', () => {
  const secretContent = 'synthetic-file-body'.repeat(10000);
  const artifact = { id: randomUUID(), complete: true, truncated: false,
    files: Array.from({ length: 1000 }, (_, i) => ({ path: `src/${i}-${'x'.repeat(400)}.ts`, beforeSha256: null, afterSha256: 'a'.repeat(64), content: secretContent })), summary: '\0'.repeat(50000) };
  const result = workerResultView({ ok: true, id: randomUUID(), source: 'kilo', text: '\0'.repeat(100000), artifact });
  const json = JSON.stringify(result);
  expect(Buffer.byteLength(json)).toBeLessThan(32768);
  expect(json).not.toContain('synthetic-file-body');
  expect(result.artifact).toMatchObject({ view: 'summary', fileCount: 1000, omittedFiles: expect.any(Number), complete: true, truncated: false });
  expect(artifact.files[0]?.content).toBe(secretContent);
});

it.each([['quota', 429], ['timeout', 504], ['cancelled', 409], ['unavailable', 503], ['busy', 429]] as const)('preserves structured %s responses, identifiers, retry times and partial artifacts', async (code, status) => {
  const id = randomUUID(), artifact = { id: randomUUID(), complete: true, truncated: false, files: [{ path: 'src/a', beforeSha256: null, afterSha256: 'a'.repeat(64), content: 'retained' }] };
  const { client, requests } = fixture(async () => Response.json({ ok: false, code, id, retryAfter: 123, reason: 'turn_limit', artifact }, { status }));
  const batch = await client.start({ tasks: [{ task: 'Edit', ownedPaths: ['src'] }] });
  const result = await client.wait({ batchId: batch.batchId }, new AbortController().signal);
  expect(result.results?.[0]).toMatchObject({ ok: false, code, id, retryAfter: 123, reason: 'turn_limit', artifact: { id: artifact.id, fileCount: 1 } });
  expect(requests.filter(item => item.path === '/run')).toHaveLength(1);
  expect(requests.filter(item => item.path === '/projects/register')).toHaveLength(1);
  await client.close();
});

it('reproves a forgotten daemon lease once before submitting an unaccepted job', async () => {
  let calls = 0;
  const { client, requests } = fixture(async () => ++calls === 1 ? Response.json({ ok: false, code: 'invalid_scope' }, { status: 403 }) : Response.json({ ok: true, id: randomUUID(), source: 'kilo', text: 'Complete' }));
  const batch = await client.start({ tasks: [{ task: 'Edit', ownedPaths: ['src'] }] });
  expect((await client.wait({ batchId: batch.batchId }, new AbortController().signal)).results?.[0]).toMatchObject({ ok: true });
  expect(calls).toBe(2); expect(requests.filter(item => item.path === '/projects/register')).toHaveLength(2);
  await client.close();
});

it('recovers an artifact after daemon restart without submitting any work', async () => {
  const base = fixture(); let rejectOnce = false;
  const fetcher = vi.fn(async (url: string | URL | Request, request?: RequestInit) => {
    if (String(url).includes(`/artifacts/${base.jobId}`) && !rejectOnce) { rejectOnce = true; return Response.json({ ok: false, code: 'invalid_scope' }, { status: 403 }); }
    return base.fetcher(url, request);
  });
  const client = new AgentWorkerBatches(8793, directory, fetcher as typeof fetch);
  await client.retained();
  expect(await client.artifact(base.jobId)).toMatchObject({ artifact: base.artifact, ownedPaths: ['src'] });
  expect(base.requests.filter(item => item.path === '/projects/register')).toHaveLength(2);
  expect(base.requests.filter(item => item.path === '/run')).toHaveLength(0);
  await client.close();
});

it.each(['network', 'forbidden', 'repeated-invalid-scope'] as const)('does not replay ambiguous or repeatedly rejected runs: %s', async mode => {
  let calls = 0;
  const { client, requests } = fixture(async () => {
    calls++;
    if (mode === 'network') throw new Error('Connection lost after acceptance may have occurred');
    return Response.json({ ok: false, code: mode === 'forbidden' ? 'permission_denied' : 'invalid_scope' }, { status: 403 });
  });
  const batch = await client.start({ tasks: [{ task: 'Edit', ownedPaths: ['src'] }] });
  expect((await client.wait({ batchId: batch.batchId }, new AbortController().signal)).results?.[0]).toMatchObject({ ok: false, code: 'unavailable' });
  expect(calls).toBe(mode === 'repeated-invalid-scope' ? 2 : 1);
  expect(requests.filter(item => item.path === '/projects/register')).toHaveLength(mode === 'repeated-invalid-scope' ? 2 : 1);
  await client.close();
});
