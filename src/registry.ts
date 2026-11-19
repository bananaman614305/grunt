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
}
export interface Registry { version: 1; published: string; adapters: Adapter[] }
const installers = { freebuff: 'npm:freebuff', opencode: 'npm:opencode-ai', kilo: 'builtin:kilo', nvidia: 'builtin:nvidia', zro: 'builtin:zro', tokenharbor: 'builtin:tokenharbor', runcrate: 'builtin:runcrate', apinex: 'builtin:apinex', 'mistral-vibe': 'builtin:mistral-vibe', livekit: 'builtin:livekit', pollinations: 'builtin:pollinations', beatapi: 'builtin:beatapi', clixad: 'builtin:clixad', perch: 'builtin:perch', nous: 'builtin:nous', kenari: 'builtin:kenari', numes: 'builtin:numes' };
export const knownAdapters = new Set(Object.keys(installers));
// These descriptors are local only and cannot be selected by registry updates.
export const localOptInAdapters: readonly Adapter[] = [
  { id: 'antseed-vikey', kind: 'model', tier: 'experimental', weight: 0.01, modalities: ['text'], install: 'builtin:antseed-vikey' },
  { id: 'reflection-beam', kind: 'model', tier: 'experimental', weight: 0.01, modalities: ['text'], install: 'builtin:reflection-beam' },
];
export const localOptInAdapterIds = new Set(localOptInAdapters.map(adapter => adapter.id));
// Retain schema compatibility with saved registries while stopping every app route.
export const disabledAdapters = new Set(['freebuff', 'apinex']);
export function validateRegistry(value: unknown): Registry {
  const fail = () => { throw new Error('Invalid adapter registry'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const registry = value as Record<string, unknown>;
  if (registry.version !== 1 || typeof registry.published !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(registry.published) || !Number.isFinite(Date.parse(registry.published))
    || !Array.isArray(registry.adapters) || !registry.adapters.length || registry.adapters.length > 100) return fail();
  const ids = new Set<string>();
  const weights = { stable: 0, experimental: 0 };
  for (const item of registry.adapters) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail();
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(a.id) || ids.has(a.id)
      || !['agent', 'model'].includes(String(a.kind)) || !['stable', 'experimental'].includes(String(a.tier))
      || typeof a.weight !== 'number' || !Number.isFinite(a.weight) || a.weight <= 0 || a.weight > 1
      || !Array.isArray(a.modalities) || !a.modalities.length || a.modalities.some(m => !['text', 'image'].includes(m))
      || new Set(a.modalities).size !== a.modalities.length || typeof a.install !== 'string' || !(/^npm:[a-z0-9@/._-]+$/.test(a.install) || (knownAdapters.has(String(a.id)) && a.install === installers[a.id as keyof typeof installers]))
      || (a.model !== undefined && (typeof a.model !== 'string' || !a.model.trim()))
      || (a.models !== undefined && (a.id !== 'opencode' || a.model !== undefined || !Array.isArray(a.models) || !a.models.length || a.models.length > 20
        || a.models.some(model => typeof model !== 'string' || !model.trim()) || new Set(a.models).size !== a.models.length))) return fail();
    if (a.signup !== undefined) {
      if (typeof a.signup !== 'string') return fail();
      let url: URL;
      try { url = new URL(a.signup); } catch { return fail(); }
      if (url.protocol !== 'https:' || url.username || url.password) return fail();
    }
    // Known adapters have fixed installers and capabilities; registry data never supplies code.
    if (knownAdapters.has(a.id) && (a.kind !== (['kilo', 'nvidia', 'zro', 'tokenharbor', 'runcrate', 'apinex', 'livekit', 'pollinations', 'beatapi', 'nous', 'kenari', 'numes'].includes(a.id) ? 'model' : 'agent') || a.install !== installers[a.id as keyof typeof installers]
      || a.modalities.some(m => m !== 'text'))) return fail();
    if (a.id === 'nous' && a.model !== 'qwen/qwen4-max:free') return fail();
    ids.add(a.id);
    weights[a.tier as Adapter['tier']] += a.weight;
  }
  if (weights.stable && weights.experimental && (Math.abs(weights.stable - 0.8) > 1e-9 || Math.abs(weights.experimental - 0.2) > 1e-9)) return fail();
  return structuredClone(value) as Registry;
}
const packaged = new URL('./registry/adapters.json', import.meta.url);
export const bundledRegistry = validateRegistry(JSON.parse(readFileSync(existsSync(packaged) ? packaged : new URL('../registry/adapters.json', import.meta.url), 'utf8')));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateRegistry(JSON.parse(readFileSync(process.argv[2] ?? 'registry/adapters.json', 'utf8')));
  console.log('Adapter registry is valid');
}
