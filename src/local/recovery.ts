import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beginSetupSession } from './setup-session.js';
import { setupFallbacks } from './fallback-setup.js';
import { approveDataSharing, registryDataSharingPolicies, requiresDataSharing } from './data-sharing.js';
import { setupFailureReason } from './setup-failure.js';
import { toolCapable } from './source.js';
import type { ModelRequest, Source } from './source.js';
import type { SignupAgent } from './signup-mcp.js';
import type { Registry } from '../registry.js';

const exec = promisify(execFile);
const RUN_TIMEOUT_MS = 10 * 60000;
// N in docs/router.md: the most coding-capable routes the daemon keeps open by itself.
export const MAX_OPEN_ROUTES = 10;
// Below this many open routes, a route leaving the open set starts a pass at once.
export const LOW_OPEN_ROUTES = 2;

// A route counts toward the open coding-route target only when it supports
// client-owned function tools and accepts ordinary (non-public) requests.
export function codingCapableRoute(source: Source, cwd: string): boolean {
  if (!toolCapable(source)) return false;
  if (!source.acceptsRequest) return true;
  const sample: ModelRequest = {
    model: 'grunt',
    cwd,
    messages: [{ role: 'user', content: '' }],
    tools: [{ type: 'function', function: { name: 'check', parameters: { type: 'object' } } }],
    stream: false
  };
  return source.acceptsRequest(sample);
}

export interface RecoveryOptions {
  directory: string;
  // Routes worth opening that are not open now, best first.
  candidates: () => Promise<readonly string[]>;
  // How many coding-capable routes are open (available and not retired).
  open: () => Promise<number>;
  // Optional override for MAX_OPEN_ROUTES.
  maxOpenRoutes?: number;
  eligible?: (id: string) => boolean;
  // Signup driver selection follows docs/router.md.
  driver?: () => Promise<SignupAgent | undefined>;
  notify?: (line: string) => void;
  // The route this pass is signing up now, or undefined between signups.
  opening?: (id: string | undefined) => void;
  setup?: typeof setupFallbacks;
  // The synced registry; signup hints follow it.
  registry?: () => Registry;
  // Each finished background signup, for the registry's route feedback.
  signedUp?: (id: string, ok: boolean) => void;
  settled?: (id: string, reason: string | undefined) => void;
}

// One greedy pass over the registry's recommended routes (docs/router.md): sign
// up one at a time, best first, until N routes are open or N attempts are made.
// The registry loop, request failures and low open routes trigger it; one pass
// runs at a time, and a trigger during a pass joins it.
export class SourceRecovery {
  private running: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private failed = new Set<string>();
  private failedSinceSync = new Set<string>();
  constructor(private options: RecoveryOptions) {}
  trigger(): void { this.start(false); }
  // After each registry sync: a full pass, and failed signups may be tried again.
  synced(): void { this.failedSinceSync.clear(); this.trigger(); }
  // A route left the open set. With fewer than LOW_OPEN_ROUTES open, start the
  // pass now over candidates that have not failed since the last registry sync.
  // A pass never starts another, so failed signups cannot loop.
  async lowRoutes(): Promise<void> {
    if (this.running || this.abort.signal.aborted) return;
    try {
      if (await this.options.open() >= LOW_OPEN_ROUTES) return;
      if (!(await this.eligible(true)).length) return;
    } catch { return; }
    this.start(true);
  }
  private start(low: boolean): void {
    if (this.running || this.abort.signal.aborted) return;
    this.running = this.recover(low).catch(error => {
      console.error(`grunt recovery stopped: ${error instanceof Error ? error.message : 'unknown error'}`);
    }).finally(() => { this.running = undefined; });
  }
  private async eligible(low: boolean): Promise<string[]> {
    const candidates = [...await this.options.candidates()].filter(id => !low || !this.failedSinceSync.has(id));
    const extraPolicies = this.options.registry ? registryDataSharingPolicies(this.options.registry()) : [];
    const sharing = candidates.filter(id => requiresDataSharing(id, extraPolicies));
    const { approved: consent } = await approveDataSharing({ directory: this.options.directory, providers: sharing,
      extraPolicies, notice: this.options.notify ?? console.error }).catch(() => ({ approved: [] }));
    const approved = new Set(consent);
    return candidates.filter(id => (!requiresDataSharing(id, extraPolicies) || approved.has(id)) && (!low || !this.options.eligible || this.options.eligible(id)));
  }
  async close(): Promise<void> {
    this.abort.abort();
    await this.running;
  }
  private async recover(low: boolean): Promise<void> {
    const notify = this.options.notify ?? console.error;
    const session = await beginSetupSession(this.options.directory, []).catch(() => undefined);
    if (!session) return;
    const signal = AbortSignal.any([this.abort.signal, session.signal]);
    try {
      signal.throwIfAborted();
      const eligible = await this.eligible(low);
      if (!low) this.failed = new Set([...this.failed].filter(id => eligible.includes(id)));
      const ordered = [...eligible.filter(id => !this.failed.has(id)), ...[...this.failed].filter(id => eligible.includes(id))];
      const maxOpen = this.options.maxOpenRoutes !== undefined && Number.isInteger(this.options.maxOpenRoutes) && this.options.maxOpenRoutes > 0
        ? this.options.maxOpenRoutes : MAX_OPEN_ROUTES;
      let attempts = 0;
      for (const id of ordered) {
        if (signal.aborted || attempts >= maxOpen || await this.options.open() >= maxOpen) break;
        // Re-checked per signup: the first route that opens drives the rest.
        const agent = await this.options.driver?.();
        signal.throwIfAborted();
        if (this.options.eligible && !this.options.eligible(id)) continue;
        attempts++;
        notify(`grunt routes: opening ${id}${agent ? ' with the fallback operator' : ''}`);
        this.options.opening?.(id);
        let reason: string | undefined;
        const outcome = await (this.options.setup ?? setupFallbacks)({
          directory: this.options.directory, adapters: [id], background: true, acquire: true, notify, signal,
          onSettled: (_id, available, failure) => { if (!available) reason = failure; },
          ...(agent ? { agent } : {}), ...(this.options.registry ? { registry: this.options.registry } : {}),
          ...(this.options.signedUp ? { signedUp: this.options.signedUp } : {}),
          run: async (binary, args, interactive) => {
            if (interactive) throw new Error(`${binary} needs an interactive terminal; run usegrunt setup`);
            await exec(binary, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, signal });
          },
        }).catch(error => {
          reason ??= setupFailureReason(error);
          return { unavailable: [id] };
        }).finally(() => this.options.opening?.(undefined));
        if (!signal.aborted) this.options.settled?.(id, outcome.unavailable.includes(id) ? reason ?? 'setup failed' : undefined);
        this.failed.delete(id);
        this.failedSinceSync.delete(id);
        if (outcome.unavailable.includes(id)) {
          this.failed.add(id);
          this.failedSinceSync.add(id);
        }
      }
    } finally { await session.close(); }
  }
}
