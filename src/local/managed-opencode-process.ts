import type { ChildProcess } from 'node:child_process';

/** An owned, detached CLI server and its descendants, never an external server. */
export class ManagedOpenCodeProcess {
  private stopping?: Promise<void>;
  private exited = false;
  private cleanupFailure: Error | undefined;
  constructor(readonly child: ChildProcess, private grouped: boolean) {
    child.once('exit', () => {
      this.exited = true;
      // Native MCP children can keep running after their server exits. The
      // detached group belongs only to this Grunt-created server generation.
      try { this.signal('SIGKILL'); } catch (error) { this.cleanupFailure = error as Error; }
    });
  }

  private signal(signal: NodeJS.Signals) {
    try {
      if (this.grouped && this.child.pid) process.kill(-this.child.pid, signal);
      else if (!this.exited) this.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  stop() {
    if (this.stopping) return this.stopping;
    if (this.exited || this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return this.cleanupFailure ? Promise.reject(this.cleanupFailure) : Promise.resolve();
    this.stopping = new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const done = () => { clearTimeout(timer); this.child.removeListener('error', failed); if (this.cleanupFailure) reject(this.cleanupFailure); else resolve(); };
      const failed = (error: Error) => { clearTimeout(timer); this.child.removeListener('exit', done); this.child.removeListener('error', failed); reject(error); };
      timer = setTimeout(() => {
        try {
          this.signal('SIGKILL');
          timer = setTimeout(() => failed(new Error('Managed OpenCode process did not exit after termination')), 1000);
          timer.unref();
        } catch (error) { failed(error as Error); }
      }, 2000);
      timer.unref();
      this.child.once('exit', done);
      this.child.once('error', failed);
      try { this.signal('SIGTERM'); } catch (error) { failed(error as Error); }
    });
    return this.stopping;
  }
}
