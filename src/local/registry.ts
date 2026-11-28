import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { bundledRegistry, isSupportedAdapter, validateRegistry } from '../registry.js';
import type { Registry } from '../registry.js';
import { hasOwnerMode } from './private-file.js';

// The slow router loop (docs/router.md): re-read the registry, then open routes.
export const REGISTRY_INTERVAL = 6 * 60 * 60 * 1000;
// Static v2 registry (includes declarative:app) on GitHub Pages with a raw GitHub fallback.
// Older daemons <= 0.10.21 continue syncing the v1-compatible /registry.json and /v1/registry feeds.
export const REGISTRY_URLS = [
  'https://grunt.run/v2/registry.json',
  'https://raw.githubusercontent.com/bananaman614305/grunt/main/registry/adapters.json'
];
// Synchronous read of the private cached registry when newer than the bundle,
// so synced adapters are recognized before they ship in a release bundle.
export function readEffectiveRegistry(directory: string): Registry {
  let fd: number | undefined;
  try {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !hasOwnerMode(parent, 0o700)) return bundledRegistry;
    const path = join(directory, 'registry.json');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || !hasOwnerMode(info, 0o600) || info.size > 1024 * 1024) return bundledRegistry;
    const saved = JSON.parse(readFileSync(fd, 'utf8')) as { registry?: unknown };
    const cached = validateRegistry(saved.registry);
    return Date.parse(cached.published) > Date.parse(bundledRegistry.published) ? cached : bundledRegistry;
  } catch { return bundledRegistry; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export class RegistrySync {
  current: Registry = structuredClone(bundledRegistry);
  private etag: string | undefined;
  // Pre-v2 caches (written by <= 0.10.23 from /registry.json) lack `feed: 2`.
  // Allow a single same-timestamp replacement when upgrading to the v2 feed.
  private legacyCache = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;
  private controller = new AbortController();
  constructor(private options: {
    directory: string;
    url?: string;
    fetcher?: typeof fetch;
    notify?: (text: string) => void;
    changed?: (registry: Registry) => void;
    // Runs after every refresh, changed or not; the daemon opens routes here.
    synced?: () => void;
    // Runs after every refresh: route feedback out, liveliness scores in.
    exchange?: () => Promise<void>;
  }) {}
  get enabled() { return this.current.adapters.filter(adapter => isSupportedAdapter(adapter)); }
  private accepts(registry: Registry) {
    const incoming = Date.parse(registry.published), current = Date.parse(this.current.published);
    // Each publication is immutable. A release's bundled list is the initial
    // floor; only a newer publication may add, change or revoke its entries
    // (except when replacing a pre-v2 cache with the v2 feed at the same timestamp).
    return incoming > current || incoming === current && (this.legacyCache || isDeepStrictEqual(
      { ...registry, published: '' }, { ...this.current, published: '' }
    ));
  }
  async load() {
    try {
      const saved = JSON.parse(await readFile(join(this.options.directory, 'registry.json'), 'utf8'));
      const registry = validateRegistry(saved.registry);
      if (this.accepts(registry)) {
        this.current = registry;
        this.etag = typeof saved.etag === 'string' ? saved.etag : undefined;
        this.legacyCache = saved.feed !== 2;
      }
    } catch { /* A missing or damaged cache uses the packaged registry. */ }
    this.options.changed?.(this.current);
  }
  sync(): Promise<void> {
    this.pending ??= this.refresh().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async refresh() {
    try {
      let registry: Registry | undefined, etag: string | undefined, unchanged = false;
      for (const url of this.options.url ? [this.options.url] : REGISTRY_URLS) {
        try {
          const response = await (this.options.fetcher ?? fetch)(url, {
            headers: this.etag ? { 'If-None-Match': this.etag } : {}, redirect: 'error',
            signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)])
          });
          if (response.status === 304) { unchanged = true; break; }
          if (response.status === 200) {
            const candidate = validateRegistry(await response.json());
            if (!this.accepts(candidate)) continue;
            registry = candidate; etag = response.headers.get('ETag') ?? undefined;
            break;
          }
          await response.body?.cancel();
        } catch { if (this.controller.signal.aborted) throw new Error('Registry sync cancelled'); }
      }
      if (registry) {
        const temporary = join(this.options.directory, `registry.${randomUUID()}.tmp`);
        try {
          await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
          await writeFile(temporary, JSON.stringify({ registry, etag, feed: 2 }), { mode: 0o600, flag: 'wx' });
          await rename(temporary, join(this.options.directory, 'registry.json'));
        } finally { await rm(temporary, { force: true }); }
        this.current = registry; this.etag = etag; this.legacyCache = false;
        this.options.changed?.(registry);
      } else if (!unchanged) throw new Error('Registry unavailable');
    } catch { this.options.notify?.('Registry update unavailable; keeping the last good list'); }
    // Advisory and never awaited: route opening does not wait on the registry API.
    if (!this.controller.signal.aborted) void this.options.exchange?.().catch(() => {});
    if (!this.controller.signal.aborted) this.options.synced?.();
  }
  async start() {
    await this.load();
    if (this.controller.signal.aborted) return;
    // Refresh the directory every interval, aligned to UTC midnight. The daemon
    // paces provider access checks independently through its daily maintenance queue.
    const schedule = () => {
      if (this.controller.signal.aborted) return;
      const now = Date.now();
      const midnight = Math.floor(now / REGISTRY_INTERVAL) * REGISTRY_INTERVAL + REGISTRY_INTERVAL;
      this.timer = setTimeout(() => {
        void this.sync().catch(() => this.options.notify?.('Background setup incomplete; run usegrunt setup to resume')).finally(schedule);
      }, midnight - now);
      this.timer.unref();
    };
    schedule();
    await this.sync();
  }
  async close() { if (this.timer) clearTimeout(this.timer); this.controller.abort(); await this.pending; }
}
