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
}
export interface Registry { version: 1; published: string; adapters: Adapter[] }
const installers = { freebuff: 'npm:freebuff', opencode: 'npm:opencode-ai', kilo: 'builtin:kilo' };
export const knownAdapters = new Set(Object.keys(installers));
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
      || new Set(a.modalities).size !== a.modalities.length || typeof a.install !== 'string' || !(/^npm:[a-z0-9@/._-]+$/.test(a.install) || (a.id === 'kilo' && a.install === 'builtin:kilo'))
      || (a.model !== undefined && (typeof a.model !== 'string' || !a.model.trim()))) return fail();
    if (a.signup !== undefined) {
      if (typeof a.signup !== 'string') return fail();
      let url: URL;
      try { url = new URL(a.signup); } catch { return fail(); }
      if (url.protocol !== 'https:' || url.username || url.password) return fail();
    }
    // Known adapters have fixed installers and capabilities; registry data never supplies code.
    if (knownAdapters.has(a.id) && (a.kind !== (a.id === 'kilo' ? 'model' : 'agent') || a.install !== installers[a.id as keyof typeof installers]
      || a.modalities.some(m => m !== 'text'))) return fail();
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
