import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setupFallbacks } from './fallback-setup.js';
import { readDataSharingConsent, requiresDataSharing } from './data-sharing.js';
import type { SignupAgent } from './signup-mcp.js';

const exec = promisify(execFile);
const RUN_TIMEOUT_MS = 10 * 60000;
// N in docs/router.md: the most routes the daemon keeps open by itself.
export const MAX_OPEN_ROUTES = 6;

export interface RecoveryOptions {
  directory: string;
  // Routes worth opening that are not open now, best first.
  candidates: () => Promise<readonly string[]>;
  // How many routes are open (available and not retired).
  open: () => Promise<number>;
  // A fallback operator when an open tool-capable route can drive signups.
  driver?: () => Promise<SignupAgent | undefined>;
  // Foreground setup owns signups while it runs.
  busy?: () => Promise<boolean>;
  notify?: (line: string) => void;
  setup?: typeof setupFallbacks;
}

// One greedy pass over the registry's recommended routes (docs/router.md): sign
// up one at a time, best first, until N routes are open or N attempts are made.
// The registry loop and request failures trigger it; one pass runs at a time.
export class SourceRecovery {
  private running: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private failedLastPass = new Set<string>();
  constructor(private options: RecoveryOptions) {}
  trigger(): void {
    if (this.running || this.abort.signal.aborted) return;
    this.running = this.recover().catch(error => {
      console.error(`grunt recovery stopped: ${error instanceof Error ? error.message : 'unknown error'}`);
    }).finally(() => { this.running = undefined; });
  }
  async close(): Promise<void> {
    this.abort.abort();
    await this.running;
  }
  private async recover(): Promise<void> {
    const notify = this.options.notify ?? console.error;
    if (await this.options.busy?.()) return;
    const candidates = [...await this.options.candidates()];
    const approved = new Set(await readDataSharingConsent(this.options.directory, candidates.filter(requiresDataSharing)));
    const eligible = candidates.filter(id => !requiresDataSharing(id) || approved.has(id));
    // A signup that failed last pass goes last, so it cannot starve the others.
    const ordered = [...eligible.filter(id => !this.failedLastPass.has(id)), ...eligible.filter(id => this.failedLastPass.has(id))];
    const failed = new Set<string>();
    let attempts = 0;
    for (const id of ordered) {
      if (this.abort.signal.aborted || attempts >= MAX_OPEN_ROUTES || await this.options.open() >= MAX_OPEN_ROUTES) break;
      attempts++;
      // Re-checked per signup: the first route that opens drives the rest.
      const agent = await this.options.driver?.();
      notify(`grunt routes: opening ${id}${agent ? ' with the fallback operator' : ''}`);
      const outcome = await (this.options.setup ?? setupFallbacks)({
        directory: this.options.directory, adapters: [id], background: true, notify, signal: this.abort.signal,
        ...(agent ? { agent } : {}),
        run: async (binary, args, interactive) => {
          if (interactive) throw new Error(`${binary} needs an interactive terminal; run usegrunt setup`);
          await exec(binary, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, signal: this.abort.signal });
        },
      }).catch(() => ({ unavailable: [id] }));
      if (outcome.unavailable.includes(id)) failed.add(id);
    }
    this.failedLastPass = failed;
  }
}
