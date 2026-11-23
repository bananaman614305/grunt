import { createHash } from 'node:crypto';
import { ADAPTER_FIELDS, NPM_INSTALL, TIER_TOTALS, adapterErrors, candidateErrors, knownAdapters, validateRegistry } from './registry.js';
import type { Adapter, Candidate, Registry, RegistryError } from './registry.js';

export const ENTRY_MAX_BYTES = 16 * 1024;
export const DEFAULT_REGISTRY_REPO = 'bananaman614305/grunt';
export type Placement = 'adapters' | 'candidates';
export type WriteResult = { registry: Registry; placed: Placement | 'registry' } | { status: 400 | 404 | 422; errors: RegistryError[] };

export const registryEtag = (registry: Registry) => '"' + createHash('sha256').update(JSON.stringify(registry)).digest('hex') + '"';
// Every write advances `published`, so clients accept it as a newer publication.
const nextPublished = (previous: string, now: number) => new Date(Math.max(now, Date.parse(previous) + 1)).toISOString();
// Keep each tier at its required total when both tiers are listed.
function normalized(adapters: Adapter[]) {
  const sums = { stable: 0, experimental: 0 };
  for (const adapter of adapters) sums[adapter.tier] += adapter.weight;
  if (!sums.stable || !sums.experimental) return adapters;
  return adapters.map(adapter => ({ ...adapter, weight: adapter.weight * TIER_TOTALS[adapter.tier] / sums[adapter.tier] }));
}
function finish(base: Registry, adapters: Adapter[], candidates: Candidate[], now: number): Registry | undefined {
  const next: Registry = { version: 1, published: nextPublished(base.published, now), adapters: normalized(adapters), ...(candidates.length ? { candidates } : {}) };
  try { return validateRegistry(next); } catch { return undefined; }
}
const replaced = <T extends { id: string }>(list: readonly T[], entry: T) => {
  const index = list.findIndex(item => item.id === entry.id);
  return index < 0 ? [...list, entry] : list.map((item, at) => at === index ? entry : item);
};
const invalid = { field: 'registry', rule: 'the resulting registry is invalid (at most 100 adapters, at least one adapter)' };

// One PUT: a shipped adapter id or an npm install goes in `adapters`, anything
// else in `candidates`. An id lives in one list only.
export function putEntry(base: Registry, id: string, body: unknown, now: number): WriteResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, errors: [{ field: 'entry', rule: 'must be a JSON object' }] };
  const value = body as Record<string, unknown>;
  if (value.id !== undefined && value.id !== id) return { status: 400, errors: [{ field: 'id', rule: 'must equal the id in the path' }] };
  const entry: Record<string, unknown> = { ...value, id };
  const candidates = (base.candidates ?? []).filter(candidate => candidate.id !== id);
  const placed: Placement = knownAdapters.has(id) || typeof entry.install === 'string' && NPM_INSTALL.test(entry.install) ? 'adapters' : 'candidates';
  if (placed === 'candidates') {
    const errors = candidateErrors(entry);
    if (errors.length) return { status: 422, errors };
    const registry = finish(base, base.adapters.filter(adapter => adapter.id !== id), replaced(candidates, entry as unknown as Candidate), now);
    return registry ? { registry, placed } : { status: 422, errors: [invalid] };
  }
  const previous = base.adapters.find(adapter => adapter.id === id);
  if (entry.weight === undefined && previous) entry.weight = previous.weight;
  const errors = [
    ...Object.keys(entry).filter(key => !ADAPTER_FIELDS.includes(key as never)).map(field => ({ field, rule: 'is not an adapter field' })),
    ...(entry.weight === undefined ? [{ field: 'weight', rule: 'is required for a new adapter entry' }] : []),
    ...adapterErrors(entry).filter(error => !(error.field === 'weight' && entry.weight === undefined)),
    // A signup is published with its hints, never without.
    ...(entry.signup !== undefined && entry.hints === undefined ? [{ field: 'hints', rule: 'is required with signup' }] : [])
  ];
  if (errors.length) return { status: 422, errors };
  const registry = finish(base, replaced(base.adapters, entry as unknown as Adapter), candidates, now);
  return registry ? { registry, placed } : { status: 422, errors: [invalid] };
}
export function deleteEntry(base: Registry, id: string, now: number): WriteResult {
  const adapters = base.adapters.filter(adapter => adapter.id !== id), candidates = (base.candidates ?? []).filter(candidate => candidate.id !== id);
  if (adapters.length === base.adapters.length && candidates.length === (base.candidates ?? []).length) return { status: 404, errors: [{ field: 'id', rule: 'is not in the registry' }] };
  const registry = finish(base, adapters, candidates, now);
  return registry ? { registry, placed: adapters.length === base.adapters.length ? 'candidates' : 'adapters' } : { status: 422, errors: [invalid] };
}

export function restoreRegistry(base: Registry, snapshot: unknown, now: number): WriteResult {
  try {
    const prior = validateRegistry(snapshot);
    const registry = { ...prior, published: nextPublished(base.published, Math.max(now, Date.parse(prior.published) + 1)) };
    return { registry: validateRegistry(registry), placed: 'registry' };
  } catch { return { status: 422, errors: [{ field: 'registry', rule: 'must be a valid registry snapshot' }] }; }
}

// A writer is any GitHub account that can push to the repository. The caller's
// own token is used only for these two reads and is never stored or logged.
export async function githubWriter(token: string, options: { repo: string; fetcher?: typeof fetch }): Promise<{ login: string } | { status: 401 | 403 | 502 }> {
  const get = (path: string) => (options.fetcher ?? fetch)(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'grunt-registry', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(5000)
  });
  try {
    const user = await get('/user');
    if (!user.ok) { await user.body?.cancel(); return { status: user.status >= 500 || user.status === 429 ? 502 : 401 }; }
    const login = (await user.json() as { login?: unknown }).login;
    if (typeof login !== 'string' || !login) return { status: 401 };
    const repo = await get(`/repos/${options.repo}`);
    if (!repo.ok) { await repo.body?.cancel(); return { status: repo.status >= 500 || repo.status === 429 ? 502 : 403 }; }
    const permissions = (await repo.json() as { permissions?: { push?: unknown } }).permissions;
    return permissions?.push === true ? { login } : { status: 403 };
  } catch { return { status: 502 }; }
}
