import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireFreePiAccountLease } from './freepi-lock.js';
let root: string;
const children: ReturnType<typeof spawn>[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'freepi-mutex-')); });
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  await rm(root, { recursive: true, force: true });
});
it('keeps a live process owner exclusive and releases automatically after SIGKILL', async () => {
  const module = new URL('./freepi-lock.ts', import.meta.url).href;
  const program = `import {acquireFreePiAccountLease} from ${JSON.stringify(module)};
    await acquireFreePiAccountLease('synthetic-shared-account', process.argv[1]);
    process.stdout.write('held\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Child did not acquire lease')), 10000);
    child.stdout!.once('data', chunk => { clearTimeout(deadline); if (String(chunk) === 'held\n') resolve(); else reject(new Error('Unexpected helper response')); });
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('exit', () => { clearTimeout(deadline); reject(new Error('Helper exited before acquisition')); });
  });
  await expect(acquireFreePiAccountLease('synthetic-shared-account', root)).rejects.toMatchObject({ code: 'quota', retryAfter: 30 });
  // A different account remains independent while this owner is alive.
  const other = await acquireFreePiAccountLease('another-synthetic-account', root); await other();
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  // Same account, same persistent file: no path deletion or stale PID decision.
  const recovered = await acquireFreePiAccountLease('synthetic-shared-account', root); await recovered();
  const files = await readdir(root); expect(files).toHaveLength(2);
  for (const file of files) { expect(file).toMatch(/^[a-f0-9]{64}\.sqlite$/); expect((await stat(join(root, file))).mode & 0o777).toBe(0o600); }
});
it('normal release is idempotent and never evicts another owner', async () => {
  const release = await acquireFreePiAccountLease('account', root); await release();
  const next = await acquireFreePiAccountLease('account', root); await release();
  await expect(acquireFreePiAccountLease('account', root)).rejects.toMatchObject({ code: 'quota' }); await next();
});
