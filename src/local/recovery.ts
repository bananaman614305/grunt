import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setupFallbacks } from './fallback-setup.js';
import { readDataSharingConsent, requiresDataSharing } from './data-sharing.js';

const exec = promisify(execFile);
const RUN_TIMEOUT_MS = 10 * 60000;

export interface RecoveryOptions {
  directory: string;
  // Sources that are installed in the pool but cannot answer right now.
  candidates: () => Promise<readonly string[]>;
  notify?: (line: string) => void;
  setup?: typeof setupFallbacks;
}

// When no source can answer, add providers without a person: reuse saved Squire
// access, then sign up, for every vetted provider whose data-sharing consent is
// already recorded. One run at a time; the next request finds the new source.
export class SourceRecovery {
  private running: Promise<void> | undefined;
  private readonly abort = new AbortController();
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
    const candidates = [...await this.options.candidates()];
    const approved = new Set(await readDataSharingConsent(this.options.directory, candidates.filter(requiresDataSharing)));
    const adapters = candidates.filter(id => !requiresDataSharing(id) || approved.has(id));
    if (!adapters.length) return;
    notify(`grunt recovery: adding ${adapters.join(', ')} because no source could answer`);
    await (this.options.setup ?? setupFallbacks)({
      directory: this.options.directory, adapters, background: true, notify, signal: this.abort.signal,
      run: async (binary, args, interactive) => {
        if (interactive) throw new Error(`${binary} needs an interactive terminal; run usegrunt setup`);
        await exec(binary, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, signal: this.abort.signal });
      },
    });
  }
}
