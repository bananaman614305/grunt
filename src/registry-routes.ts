import { fleetPrincipal, fleetToken, saveHour, validHour } from './fleet.js';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import { ID_PATTERN, bundledRegistry, validateRegistry } from './registry.js';
import type { Registry } from './registry.js';
import { DEFAULT_REGISTRY_REPO, ENTRY_MAX_BYTES, deleteEntry, githubWriter, putEntry, registryEtag, restoreRegistry } from './registry-write.js';
import type { WriteResult } from './registry-write.js';
import { FEEDBACK_MAX_BYTES, parseFeedback } from './registry-store.js';
import type { RegistryStore } from './registry-store.js';
import { registryInstructions } from './registry-instructions.js';

export interface RegistryRouteOptions { path?: string; store?: RegistryStore; repo?: string; fetcher?: typeof fetch; now?: () => number; commit?: string; fleetSecret?: string }
const bearer = (value: string | undefined) => value?.match(/^Bearer ([A-Za-z0-9._~-]{32,8192})$/i)?.[1];
const commitOf = (image: string | undefined) => image?.match(/:([0-9a-f]{40})$/)?.[1];

// The registry API. Every write goes through PUT or DELETE on this server.
export function registryRoutes(options: string | RegistryRouteOptions = {}) {
  const config = typeof options === 'string' ? { path: options } : options;
  const path = config.path ?? process.env.GRUNT_REGISTRY_FILE ?? '/data/registry.json';
  const repo = config.repo ?? process.env.GRUNT_REGISTRY_REPO ?? DEFAULT_REGISTRY_REPO;
  const now = config.now ?? Date.now, store = config.store, commit = config.commit ?? commitOf(process.env.FLY_IMAGE_REF);
  const published = async () => validateRegistry(JSON.parse(await readFile(path, 'utf8')));
  // A write rebases on the bundled list when the published file is missing or invalid.
  const current = () => published().catch(() => structuredClone(bundledRegistry));
  let writing: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>) => {
    const run = writing.then(operation);
    writing = run.catch(() => {});
    return run;
  };
  const publish = async (registry: Registry, login: string, base?: Registry, id?: string) => {
    if (!store) throw new Error('Registry writes are unavailable');
    const next = validateRegistry(registry);
    const temporary = join(dirname(path), `registry.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      const write = await store.recordWrite(login, id ?? 'registry', base, next);
      await rename(temporary, path);
      return write;
    } finally { await rm(temporary, { force: true }); }
  };
  const initialize = () => serialized(async () => {
    try { await readFile(path); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await publish({ ...structuredClone(bundledRegistry), published: new Date(Math.max(now(), Date.parse(bundledRegistry.published) + 1)).toISOString() }, 'system');
  });
  const fleetSecret = config.fleetSecret ?? process.env.GRUNT_FLEET_SIGNING_SECRET ?? process.env.GRUNT_ADMIN_SESSION_SECRET;
  const app = new Hono();
  app.get('/v1/registry', async c => {
    try {
      const registry = await published();
      const etag = registryEtag(registry);
      c.header('ETag', etag);
      c.header('Cache-Control', 'public, max-age=0, must-revalidate');
      if (c.req.header('If-None-Match')?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) return c.body(null, 304);
      c.header('Content-Type', 'application/json');
      return c.body(JSON.stringify(registry));
    } catch { return c.json({ error: 'No valid registry has been published' }, 503); }
  });
  const write = async (c: Context, change: (base: Registry, at: number) => WriteResult | Promise<WriteResult>) => {
    if (!store) return c.json({ error: 'Registry writes are unavailable' }, 503);
    const id = c.req.param('id') ?? 'registry';
    if (!ID_PATTERN.test(id)) return c.json({ errors: [{ field: 'id', rule: `must match ${ID_PATTERN}` }] }, 400);
    const token = bearer(c.req.header('Authorization'));
    if (!token) return c.json({ error: 'Send a GitHub token as Authorization: Bearer <token>' }, 401);
    const writer = await githubWriter(token, { repo, ...(config.fetcher ? { fetcher: config.fetcher } : {}) });
    if ('status' in writer) return c.json({ error: writer.status === 401 ? 'GitHub rejected the token' : writer.status === 403 ? `The token's account cannot push to ${repo}` : 'GitHub is unavailable' }, writer.status);
    // One write at a time on this single machine; each rebases on the last.
    const run = serialized(async () => {
      const base = await current();
      const result = await change(base, now());
      if ('errors' in result) return result;
      return { ...result, write: await publish(result.registry, writer.login, base, id) };
    });
    try {
      const result = await run;
      if ('errors' in result) return c.json({ errors: result.errors }, result.status);
      return c.json({ published: result.registry.published, etag: registryEtag(result.registry), placed: result.placed, write: result.write });
    } catch { return c.json({ error: 'The registry could not be written' }, 500); }
  };
  app.put('/v1/registry/entries/:id', bodyLimit({ maxSize: ENTRY_MAX_BYTES, onError: c => c.json({ error: 'Entry is too large' }, 413) }), async c => {
    const text = await c.req.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { return c.json({ errors: [{ field: 'entry', rule: 'must be a JSON object' }] }, 400); }
    return write(c, (base, at) => putEntry(base, c.req.param('id'), body, at));
  });
  app.delete('/v1/registry/entries/:id', c => write(c, (base, at) => deleteEntry(base, c.req.param('id'), at)));
  app.put('/v1/registry/reverts/:write', c => write(c, async (base, at) => {
    const value = c.req.param('write');
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) return { status: 400, errors: [{ field: 'write', rule: 'must be a positive safe integer' }] };
    const snapshot = await store?.beforeWrite(Number(value));
    if (snapshot === undefined || snapshot === null) return { status: 404, errors: [{ field: 'write', rule: 'has no prior registry snapshot' }] };
    return restoreRegistry(base, JSON.parse(snapshot), at);
  }));
  // Anonymous daily route counts from local routers. Only the allowlisted
  // schema is accepted; no address, body or header is stored or logged.
  app.post('/v1/registry/feedback', bodyLimit({ maxSize: FEEDBACK_MAX_BYTES, onError: c => c.json({ error: 'Report is too large' }, 413) }), async c => {
    if (!store) return c.json({ error: 'Feedback is unavailable' }, 503);
    const text = await c.req.text();
    const proof = c.req.header('X-Grunt-Fleet') ?? '';
    const enrolling = /^[a-f0-9]{64}$/.test(proof);
    let report;
    try { report = parseFeedback(JSON.parse(text), await current(), now(), enrolling); } catch { report = undefined; }
    if (!report) return c.json({ error: 'Invalid feedback report' }, 400);
    try { await store.recordFeedback(report); } catch { return c.json({ error: 'Feedback is unavailable' }, 503); }
    if (enrolling && fleetSecret && fleetSecret.length >= 32) {
      c.header('Cache-Control','no-store');
      c.header('X-Grunt-Fleet-Token', fleetToken(createHash('sha256').update(proof).digest('hex'), fleetSecret));
    }
    return c.body(null, 204);
  });
  app.post('/v1/registry/fleet', bodyLimit({ maxSize: 65536 }), async c => {
    const token = bearer(c.req.header('Authorization'));
    const installation = fleetPrincipal(token ?? '',fleetSecret);
    if (!installation) return c.body(null, 401);
    if (!store) return c.body(null, 503);
    const payload: unknown = await c.req.json().catch(() => null);
    const at = now();
    if (!validHour(payload, at)) return c.body(null, 400);
    await saveHour(store.db, installation, payload, at);
    return c.body(null, 204);
  });
  app.get('/v1/registry/scores', async c => {
    if (!store) return c.json({ error: 'Scores are unavailable' }, 503);
    try {
      const scores = await store.scores(await current());
      c.header('Cache-Control', 'public, max-age=0, must-revalidate');
      return c.json(scores);
    } catch { return c.json({ error: 'Scores are unavailable' }, 503); }
  });
  app.get('/v1/registry/instructions', async c => {
    const registry = await current(), at = now();
    const scores = await store?.scores(registry).catch(() => undefined) ?? { computed: new Date(at).toISOString(), summary: { entries: 0, live: 0, median: null }, scores: {} };
    const url = new URL(c.req.url);
    const base = `${['localhost', '127.0.0.1'].includes(url.hostname) ? url.protocol : 'https:'}//${url.host}`;
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=0, must-revalidate');
    return c.body(registryInstructions({ registry, scores, base, repo, now: at, ...(commit ? { commit } : {}) }));
  });
  return Object.assign(app, { initialize });
}
