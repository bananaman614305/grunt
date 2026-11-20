import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalApp } from './api.js';
import { DiagnosticsStore } from './diagnostics.js';
import { Sources, answeredBy } from './source.js';
import { WorkerPool } from './worker-pool.js';
import { WorkerScopes } from './worker-scopes.js';
import type { WorkerAgentWorkspace } from './worker-agent.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grunt-api-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(project); await writeFile(join(project, 'file.txt'), 'Original');
  const scopes = new WorkerScopes();
  const complete = vi.fn(async () => { const result = { text: 'Synthetic answer' }; answeredBy.set(result, 'kilo'); return result; });
  const workspace: WorkerAgentWorkspace = { id: 'synthetic', path: '/synthetic/private', tools: [{type:'function',function:{name:'worker_read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}}], executeTool: vi.fn(), cleanup: vi.fn(),
    artifact: async () => ({ id: 'synthetic', files: [{ path: 'file.txt', beforeSha256: createHash('sha256').update('Original').digest('hex'), afterSha256: createHash('sha256').update('Change').digest('hex'), content: 'Change' }], complete: true, truncated: false }) };
  const createAgentWorkspace = vi.fn(async () => workspace);
  const workers = new WorkerPool({ complete }, 10000, { createAgentWorkspace });
  const app = createLocalApp(new Sources([{id:'synthetic',available:async()=>true,complete:async()=>({text:'unused'})}]), { workers, workerScopes: scopes });
  const request = (path: string, body?: unknown, token?: string, extra: Record<string, string> = {}) => app.request(`http://127.0.0.1:8788${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }
  });
  const register = async (path = project) => {
    const challenge = await (await request('/v1/workers/projects/challenge', { projectRoot: path })).json();
    await writeFile(join(path, challenge.fileName), challenge.nonce, { flag: 'wx', mode: 0o600 });
    const registered = await request('/v1/workers/projects/register', { challengeId: challenge.challengeId });
    expect(registered.status).toBe(200); return (await registered.json()).token as string;
  };
  return { root, project, app, scopes, workers, complete, workspace, createAgentWorkspace, request, register };
}
const task = { mode: 'agent', task: 'Edit synthetic file', ownedPaths: ['file.txt'] };

it('requires current-project proof and keeps transport scope outside model task', async () => {
  const f = await fixture();
  expect((await f.request('/v1/workers/run', task)).status).toBe(403);
  expect(f.createAgentWorkspace).not.toHaveBeenCalled();
  const token = await f.register();
  const snapshot = [{ path: 'file.txt', content: 'Original' }];
  const response = await f.request('/v1/workers/run', { ...task, initialSnapshot: snapshot }, token);
  expect(response.status).toBe(200);
  expect(f.createAgentWorkspace).toHaveBeenCalledWith({ projectRoot: f.project, projectIdentity: expect.stringMatching(/^[a-f0-9]{64}$/), ownedPaths: ['file.txt'], initialSnapshot: snapshot }, expect.any(AbortSignal));
  expect(JSON.stringify(f.complete.mock.calls)).not.toContain(token);
  expect(JSON.stringify(f.complete.mock.calls)).not.toContain('initialSnapshot');
  expect(await readFile(join(f.project, 'file.txt'), 'utf8')).toBe('Original');
  await f.workers.close();
});
it('rejects registration without caller-created proof and forbids browser origins and wrong hosts', async () => {
  const f = await fixture();
  const challenge = await (await f.request('/v1/workers/projects/challenge', { projectRoot: f.project })).json();
  expect((await f.request('/v1/workers/projects/register', { challengeId: challenge.challengeId })).status).toBe(403);
  expect((await f.request('/v1/workers/projects/challenge', { projectRoot: f.project }, undefined, { Origin: 'https://attacker.test' })).status).toBe(403);
  expect((await f.app.request('http://attacker.test/v1/workers/capabilities')).status).toBe(403);
});
it('scopes retained artifacts and explicit discard to exactly the proved project', async () => {
  const f = await fixture(), token = await f.register();
  const result = await (await f.request('/v1/workers/run', task, token)).json();
  await vi.waitFor(() => expect(f.workers.status().active).toHaveLength(0));
  const other = join(f.root, 'other'); await mkdir(other); const otherToken = await f.register(other);
  expect((await f.request(`/v1/workers/artifacts/${result.id}`, undefined, otherToken)).status).toBe(404);
  expect(await (await f.request('/v1/workers/retained', undefined, otherToken)).json()).toEqual({ retained: [] });
  const artifact = await f.request(`/v1/workers/artifacts/${result.id}`, undefined, token);
  expect(artifact.status).toBe(200); expect(artifact.headers.get('cache-control')).toBe('no-store');
  expect(await artifact.json()).toMatchObject({artifact:{files:[{content:'Change'}]},ownedPaths:['file.txt']});
  expect((await f.request(`/v1/workers/artifacts/${result.id}/discard`, {}, otherToken)).status).toBe(404);
  expect(f.workspace.cleanup).not.toHaveBeenCalled();
  expect((await f.request(`/v1/workers/artifacts/${result.id}/discard`, {}, token)).status).toBe(200);
  expect(f.workspace.cleanup).toHaveBeenCalledTimes(1);
  expect((await f.request(`/v1/workers/artifacts/${result.id}`, undefined, token)).status).toBe(404);
  expect((await f.request('/v1/workers/apply', {}, token)).status).toBe(404);
  expect(await readFile(join(f.project, 'file.txt'), 'utf8')).toBe('Original');
});
it('revokes project access and ignores forged token material', async () => {
  const f = await fixture(), token = await f.register();
  expect((await f.request('/v1/workers/retained', undefined, 'f'.repeat(64))).status).toBe(403);
  expect(await (await f.request('/v1/workers/projects/revoke', {}, token)).json()).toEqual({ ok: true });
  expect((await f.request('/v1/workers/run', task, token)).status).toBe(403);
});
it('rejects body-supplied cwd, authorization and proposal snapshots', async () => {
  const f = await fixture(), token = await f.register();
  for (const extra of [{ cwd: '/tmp' }, { projectRoot: f.project }, { token }]) expect((await f.request('/v1/workers/run', { ...task, ...extra }, token)).status).toBe(400);
  expect((await f.request('/v1/workers/run', { task: 'Legacy', initialSnapshot: [] }, token)).status).toBe(400);
  expect(f.createAgentWorkspace).not.toHaveBeenCalled();
});
it.each([
  [{ path: '../secret', content: '' }], [{ path: 'x', content: 'x', sha256: '0'.repeat(64) }],
  [{ path: 'x', content: '!!!', binary: true }], [{ path: 'x', content: 'AB==', binary: true }], [{ path: 'x', content: '' }, { path: 'x', content: '' }],
  [{ path: 'x', content: 'x', extra: true }], [{ path: 'x', content: 'x'.repeat(4 * 1024 * 1024 + 1) }]
])('rejects malformed or oversized snapshot before creating a workspace', async snapshot => {
  const f = await fixture(), token = await f.register();
  const result = await f.request('/v1/workers/run', { ...task, initialSnapshot: snapshot }, token);
  expect(result.status).toBe(400); expect(f.createAgentWorkspace).not.toHaveBeenCalled();
});
it('preserves legacy proposal limits and valid no-capability calls', async () => {
  const f = await fixture();
  expect((await f.request('/v1/workers/run', { task: 'Legacy proposal' })).status).toBe(200);
  expect((await f.request('/v1/workers/run', { task: 'x'.repeat(256 * 1024) })).status).toBe(413);
  expect(f.createAgentWorkspace).not.toHaveBeenCalled();
});
it('bounds the entire HTTP body before parsing', async () => {
  const f = await fixture();
  const response = await f.app.request('http://127.0.0.1:8788/v1/workers/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(8 * 1024 * 1024 + 1) });
  expect(response.status).toBe(413); expect(f.createAgentWorkspace).not.toHaveBeenCalled();
});

it('marks ordinary API calls as client and ignores body-supplied worker authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-api-actor-')); roots.push(root);
  const store = await DiagnosticsStore.open({ directory: root });
  try {
    const complete = vi.fn(async () => ({ text: 'Synthetic answer' }));
    const sources = new Sources([{id:'synthetic',available:async()=>true,complete}]); sources.setDiagnostics(store);
    const app = createLocalApp(sources);
    const response = await app.request('http://127.0.0.1:8788/v1/chat/completions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'synthetic',cwd:'/tmp',messages:[{role:'user',content:'Synthetic'}],actor:'worker',workerId:'00000000-0000-4000-8000-000000000000',worker:{id:'forged'}})});
    expect(response.status).toBe(200);
    const trace = await store.trace(response.headers.get('X-Grunt-Request-Id')!);
    expect(trace.events.filter(row => row.type.startsWith('request.')).map(row=>row.actor)).toEqual(['client','client']);
    expect(trace.events.every(row=>row.actor==='client' && !row.workerId)).toBe(true);
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty('worker');
  } finally { await store.close(); }
});

it('never exposes a former project artifact to a replacement directory at the same path', async () => {
  const f = await fixture(), token = await f.register();
  const result = await (await f.request('/v1/workers/run', task, token)).json();
  await vi.waitFor(() => expect(f.workers.status().active).toHaveLength(0));
  await rename(f.project, join(f.root, 'original-project')); await mkdir(f.project);
  const replacementToken = await f.register();
  expect((await f.request(`/v1/workers/artifacts/${result.id}`, undefined, replacementToken)).status).toBe(404);
  expect(await (await f.request('/v1/workers/retained', undefined, replacementToken)).json()).toEqual({retained:[]});
  expect((await f.request(`/v1/workers/artifacts/${result.id}`, undefined, token)).status).toBe(403);
});
it('recovery failure disables scoped workers while ordinary inference stays usable', async () => {
  const f = await fixture(); vi.spyOn(f.workers, 'ready').mockRejectedValue(new Error('Private failure detail'));
  const response = await f.request('/v1/workers/retained');
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('Private');
  const normal = await f.request('/v1/chat/completions', {model:'synthetic',cwd:'/tmp',messages:[{role:'user',content:'Synthetic'}]});
  expect(normal.status).toBe(200);
});

it('accepts canonical binary snapshots within decoded byte bounds', async () => {
  const f = await fixture(), token = await f.register();
  const content = Buffer.alloc(4 * 1024 * 1024, 17).toString('base64');
  const result = await f.request('/v1/workers/run', { ...task, initialSnapshot: [{path:'asset.bin',binary:true,content}] }, token);
  expect(result.status).toBe(200); expect(f.createAgentWorkspace).toHaveBeenCalledTimes(1);
});
