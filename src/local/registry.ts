import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { bundledRegistry, isSupportedAdapter, validateRegistry } from '../registry.js';
import type { Registry } from '../registry.js';

// The slow router loop (docs/router.md): re-read the registry, then open routes.
export const REGISTRY_INTERVAL = 6 * 60 * 60 * 1000;
// Static registry hosted on GitHub Pages with a raw GitHub fallback.
export const REGISTRY_URLS = [
  'https://grunt.run/registry.json',
  'https://raw.githubusercontent.com/bananaman614305/grunt/main/registry/adapters.json'
];
export class RegistrySync {
  current: Registry = structuredClone(bundledRegistry);
  private etag: string | undefined;
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
    // floor; only a newer publication may add, change or revoke its entries.
    return incoming > current || incoming === current && isDeepStrictEqual(
      { ...registry, published: '' }, { ...this.current, published: '' }
    );
  }
  async load() {
    try {
      const saved = JSON.parse(await readFile(join(this.options.directory, 'registry.json'), 'utf8'));
      const registry = validateRegistry(saved.registry);
      if (this.accepts(registry)) {
        this.current = registry;
        this.etag = typeof saved.etag === 'string' ? saved.etag : undefined;
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
          await writeFile(temporary, JSON.stringify({ registry, etag }), { mode: 0o600, flag: 'wx' });
          await rename(temporary, join(this.options.directory, 'registry.json'));
        } finally { await rm(temporary, { force: true }); }
        this.current = registry; this.etag = etag;
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
