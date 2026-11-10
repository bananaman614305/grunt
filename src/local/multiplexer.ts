import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { SourceError } from './source.js';
const exec = promisify(execFile);
export async function executable(name: string) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try { const path = join(dir, name); await access(path, constants.X_OK); return path; } catch { /* next PATH entry */ }
  }
  throw new SourceError('not_installed', `${name} is not installed or executable on PATH`);
}
export interface Multiplexer {
  start(id: string, cwd: string, binary: string, continuation?: string): Promise<void>;
  send(id: string, prompt: string): Promise<void>;
  stop(id: string): Promise<void>;
  close?(): Promise<void>;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export class Tmux implements Multiplexer {
  private socket = `milo-local-${process.pid}-${randomUUID()}`;
  private closed = false;
  private launches = new Set<Promise<unknown>>();
  private async run(args: string[], input?: string) {
    const command = exec(await executable('tmux'), args, { timeout: 5000, maxBuffer: 65536 });
    if (input !== undefined) command.child.stdin?.end(input);
    return command;
  }
  async start(id: string, cwd: string, binary: string, continuation?: string) {
    // Keep the private server alive across empty-session handoffs. Closing the
    // daemon kills this socket explicitly, without touching the user's server.
    if (this.closed) throw new SourceError('upstream', 'Milo multiplexer is closed');
    const launch = this.run(['-L', this.socket, 'new-session', '-d', '-s', id, '-c', cwd, '-x', '180', '-y', '50', `${quote(binary)} --cwd ${quote(cwd)}${continuation ? ` --continue ${quote(continuation)}` : ''}`, ';', 'set-option', '-s', 'exit-empty', 'off']);
    this.launches.add(launch);
    try { await launch; } finally { this.launches.delete(launch); }
  }
  async send(id: string, prompt: string) {
    // Bracketed paste preserves multiline transcripts and avoids shell/key interpretation.
    await this.run(['-L', this.socket, 'load-buffer', '-b', id, '-'], prompt);
    try { await this.run(['-L', this.socket, 'paste-buffer', '-p', '-b', id, '-t', `${id}:0.0`]); }
    finally { await this.run(['-L', this.socket, 'delete-buffer', '-b', id]); }
    await this.run(['-L', this.socket, 'send-keys', '-t', `${id}:0.0`, 'Enter']);
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.launches]);
    await this.run(['-L', this.socket, 'kill-server']).catch(() => {});
  }
  async stop(id: string) { await this.run(['-L', this.socket, 'kill-session', '-t', id]).catch(() => {}); }
}
