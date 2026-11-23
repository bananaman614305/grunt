import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface Adapter {
  id: string;
  kind: 'agent' | 'model';
  tier: 'stable' | 'experimental';
  weight: number;
  modalities: ('text' | 'image')[];
  install: string;
  signup?: string;
  model?: string;
  models?: string[];
  // Set by the daily provider scout (docs/router.md). Missing means possible/active.
  fit?: 'great' | 'possible' | 'poor';
  status?: 'active' | 'expiring' | 'inactive';
  expires?: string;
  // Optional page-by-page notes for the free signup: the controls to press and
  // the Grunt-supplied values to type, in order. Appended to Squire's drive goal.
  hints?: string;
}
// A provider listed in the registry before Grunt ships an adapter for it. Every
// client ignores this list; the provider scout ships adapters from it.
export interface Candidate { id: string; signup: string; hints: string; name?: string; models?: string[]; docs?: string; notes?: string }
export interface Registry { version: 1; published: string; adapters: Adapter[]; candidates?: Candidate[] }
export interface RegistryError { field: string; rule: string }
// The schema constants below are shared by the validator and the published agent instructions.
export const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const NPM_INSTALL = /^npm:[a-z0-9@/._-]+$/;
export const PUBLISHED_PATTERN = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
export const DAY_PATTERN = /^\d{4}-\d\d-\d\d$/;
export const HINTS_MAX = 2000;
export const NOTES_MAX = 500;
export const NAME_MAX = 100;
export const MODELS_MAX = 20;
export const ADAPTERS_MAX = 100;
export const KINDS = ['agent', 'model'] as const;
export const TIERS = ['stable', 'experimental'] as const;
export const MODALITIES = ['text', 'image'] as const;
export const FITS = ['great', 'possible', 'poor'] as const;
export const STATUSES = ['active', 'expiring', 'inactive'] as const;
export const ADAPTER_FIELDS = ['id', 'kind', 'tier', 'weight', 'modalities', 'install', 'signup', 'model', 'models', 'fit', 'status', 'expires', 'hints'] as const;
export const CANDIDATE_FIELDS = ['id', 'signup', 'hints', 'name', 'models', 'docs', 'notes'] as const;
export const TIER_TOTALS = { stable: 0.8, experimental: 0.2 } as const;
export const installers: Readonly<Record<string, string>> = { freebuff: 'npm:freebuff', opencode: 'npm:opencode-ai', kilo: 'builtin:kilo', nvidia: 'builtin:nvidia', zro: 'builtin:zro', tokenharbor: 'builtin:tokenharbor', runcrate: 'builtin:runcrate', apinex: 'builtin:apinex', 'mistral-vibe': 'builtin:mistral-vibe', livekit: 'builtin:livekit', pollinations: 'builtin:pollinations', beatapi: 'builtin:beatapi', perch: 'builtin:perch', nous: 'builtin:nous', kenari: 'builtin:kenari', numes: 'builtin:numes', goedel: 'builtin:goedel', crowllm: 'builtin:crowllm', fikra: 'builtin:fikra', openference: 'builtin:openference', darus: 'builtin:darus', 'aperture-ai': 'builtin:aperture-ai', 'reflection-beam': 'builtin:reflection-beam', 'antseed-vikey': 'builtin:antseed-vikey', millionseek: 'builtin:millionseek', freepi: 'builtin:freepi' };
export const knownAdapters = new Set(Object.keys(installers));
// Shipped adapters with kind "model"; the other shipped adapters are agents.
export const modelAdapters = new Set(['kilo', 'nvidia', 'zro', 'tokenharbor', 'runcrate', 'apinex', 'livekit', 'pollinations', 'beatapi', 'nous', 'kenari', 'numes', 'goedel', 'crowllm', 'fikra', 'openference', 'darus', 'aperture-ai', 'reflection-beam', 'antseed-vikey', 'millionseek', 'freepi']);
// Shipped adapters whose code serves exactly one model.
export const pinnedModels: Readonly<Record<string, string>> = { 'aperture-ai': 'baidu/ernie-5.5-flash-preview:free', darus: 'darus/deepseek-v4.1-flash-1017-FREE', fikra: 'deepseek-v4-1-flash-economy-free', openference: 'DeepSeek-V4.1-Flash-1017-Free', crowllm: 'glm-5.3-flash:free', 'reflection-beam': 'reflection/beam-free', millionseek: 'deepseek-v4.1-flash-free', freepi: 'deepseek-v4.1-flash', 'antseed-vikey': 'deepseek/deepseek-v4.1-flash-free', goedel: 'deepseek/deepseek-v4.1-flash', nous: 'qwen/qwen4-max:free' };
// Explicit fallback descriptors do not enroll sources in the bundled registry.
export const localOptInAdapters: readonly Adapter[] = [
  { id: 'crowllm', kind: 'model', tier: 'experimental', weight: 0.01, modalities: ['text'], install: 'builtin:crowllm', model: 'glm-5.3-flash:free' },
  { id: 'antseed-vikey', kind: 'model', tier: 'experimental', weight: 0.01, modalities: ['text'], install: 'builtin:antseed-vikey' },
];
export const localOptInAdapterIds = new Set(localOptInAdapters.map(adapter => adapter.id));
// Keep retired IDs as tombstones for saved selections and explicit requests.
// Clixad's installer/source are removed; its ID must not become an automatic
// fallback alias or send an old setup request through legacy provisioning.
export const disabledAdapters = new Set(['freebuff', 'apinex', 'clixad']);
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const nonBlank = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const httpsUrl = (value: unknown) => {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
};
const hintsValid = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= HINTS_MAX;
const dayValid = (value: unknown) => typeof value === 'string' && DAY_PATTERN.test(value) && Number.isFinite(Date.parse(value));
// Fixed rule text for each field, shared by the write errors and the published instructions.
export const ADAPTER_RULES = {
  id: `must match ${ID_PATTERN}`,
  kind: `must be one of ${KINDS.join(', ')}; a shipped adapter keeps its shipped kind`,
  tier: `must be one of ${TIERS.join(', ')}`,
  weight: 'must be a number greater than 0 and at most 1',
  modalities: `must be a non-empty list of distinct values from ${MODALITIES.join(', ')}; text only for a shipped adapter`,
  install: 'must be the shipped installer for a shipped adapter id, otherwise npm:<package>',
  signup: 'must be an https URL without credentials',
  model: 'must be a non-blank string; a single-model shipped adapter keeps its shipped model',
  models: `only opencode may list models: 1 to ${MODELS_MAX} distinct non-blank strings, without model`,
  fit: `must be one of ${FITS.join(', ')}`,
  status: `must be one of ${STATUSES.join(', ')}`,
  expires: 'must be a YYYY-MM-DD day',
  hints: `must be non-blank text of at most ${HINTS_MAX} characters`
} as const satisfies Record<typeof ADAPTER_FIELDS[number], string>;
export const CANDIDATE_RULES = {
  id: ADAPTER_RULES.id,
  signup: ADAPTER_RULES.signup,
  hints: ADAPTER_RULES.hints,
  name: `must be non-blank text of at most ${NAME_MAX} characters`,
  models: `must be 1 to ${MODELS_MAX} distinct non-blank strings`,
  docs: 'must be an https URL without credentials',
  notes: `must be text of at most ${NOTES_MAX} characters`
} as const satisfies Record<typeof CANDIDATE_FIELDS[number], string>;
// One adapter entry's schema violations, with fixed rule text. Empty means valid.
export function adapterErrors(value: unknown): RegistryError[] {
  const a = record(value);
  if (!a) return [{ field: 'entry', rule: 'must be a JSON object' }];
  const errors: RegistryError[] = [];
  const check = (ok: unknown, field: keyof typeof ADAPTER_RULES) => { if (!ok && !errors.some(error => error.field === field)) errors.push({ field, rule: ADAPTER_RULES[field] }); };
  const id = typeof a.id === 'string' && ID_PATTERN.test(a.id) ? a.id : undefined;
  const known = id !== undefined && knownAdapters.has(id);
  const modalities = Array.isArray(a.modalities) ? a.modalities as unknown[] : undefined;
  check(id, 'id');
  check(KINDS.includes(a.kind as never), 'kind');
  check(TIERS.includes(a.tier as never), 'tier');
  check(typeof a.weight === 'number' && Number.isFinite(a.weight) && a.weight > 0 && a.weight <= 1, 'weight');
  check(modalities && modalities.length && modalities.every(m => MODALITIES.includes(m as never)) && new Set(modalities).size === modalities.length, 'modalities');
  check(typeof a.install === 'string' && (NPM_INSTALL.test(a.install) || known && a.install === installers[id as string]), 'install');
  check(a.model === undefined || nonBlank(a.model), 'model');
  check(a.models === undefined || a.id === 'opencode' && a.model === undefined && Array.isArray(a.models) && a.models.length && a.models.length <= MODELS_MAX
    && a.models.every(nonBlank) && new Set(a.models).size === a.models.length, 'models');
  check(a.fit === undefined || FITS.includes(a.fit as never), 'fit');
  check(a.status === undefined || STATUSES.includes(a.status as never), 'status');
  check(a.hints === undefined || hintsValid(a.hints), 'hints');
  check(a.expires === undefined || dayValid(a.expires), 'expires');
  check(a.signup === undefined || httpsUrl(a.signup), 'signup');
  // Known adapters have fixed installers and capabilities; registry data never supplies code.
  if (known) {
    check(a.kind === (modelAdapters.has(id as string) ? 'model' : 'agent'), 'kind');
    check(a.install === installers[id as string], 'install');
    check(!modalities || modalities.every(m => m === 'text'), 'modalities');
    check(pinnedModels[id as string] === undefined || a.model === pinnedModels[id as string], 'model');
  }
  return errors;
}
// One candidate entry's schema violations, with fixed rule text. Empty means valid.
export function candidateErrors(value: unknown): RegistryError[] {
  const c = record(value);
  if (!c) return [{ field: 'entry', rule: 'must be a JSON object' }];
  const errors: RegistryError[] = [];
  const check = (ok: unknown, field: keyof typeof CANDIDATE_RULES) => { if (!ok) errors.push({ field, rule: CANDIDATE_RULES[field] }); };
  check(typeof c.id === 'string' && ID_PATTERN.test(c.id), 'id');
  check(httpsUrl(c.signup), 'signup');
  check(hintsValid(c.hints), 'hints');
  check(c.name === undefined || nonBlank(c.name) && c.name.length <= NAME_MAX, 'name');
  check(c.models === undefined || Array.isArray(c.models) && c.models.length && c.models.length <= MODELS_MAX && c.models.every(nonBlank)
    && new Set(c.models).size === c.models.length, 'models');
  check(c.docs === undefined || httpsUrl(c.docs), 'docs');
  check(c.notes === undefined || typeof c.notes === 'string' && c.notes.length <= NOTES_MAX, 'notes');
  for (const key of Object.keys(c)) if (!CANDIDATE_FIELDS.includes(key as never)) errors.push({ field: key, rule: 'is not a candidate field' });
  return errors;
}
export function validateRegistry(value: unknown): Registry {
  const fail = () => { throw new Error('Invalid adapter registry'); };
  const registry = record(value);
  if (!registry || registry.version !== 1 || typeof registry.published !== 'string' || !PUBLISHED_PATTERN.test(registry.published) || !Number.isFinite(Date.parse(registry.published))
    || !Array.isArray(registry.adapters) || !registry.adapters.length || registry.adapters.length > ADAPTERS_MAX) return fail();
  const ids = new Set<string>();
  const weights = { stable: 0, experimental: 0 };
  for (const item of registry.adapters as unknown[]) {
    if (adapterErrors(item).length) return fail();
    const a = item as Adapter;
    if (ids.has(a.id)) return fail();
    ids.add(a.id);
    weights[a.tier] += a.weight;
  }
  if (weights.stable && weights.experimental && (Math.abs(weights.stable - TIER_TOTALS.stable) > 1e-9 || Math.abs(weights.experimental - TIER_TOTALS.experimental) > 1e-9)) return fail();
  return structuredClone(value) as Registry;
}
const packaged = new URL('./registry/adapters.json', import.meta.url);
export const bundledRegistry = validateRegistry(JSON.parse(readFileSync(existsSync(packaged) ? packaged : new URL('../registry/adapters.json', import.meta.url), 'utf8')));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateRegistry(JSON.parse(readFileSync(process.argv[2] ?? 'registry/adapters.json', 'utf8')));
  console.log('Adapter registry is valid');
}
