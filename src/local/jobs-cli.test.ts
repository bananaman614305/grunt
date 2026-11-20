import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { jobsCommand } from './jobs-cli.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('executes only an explicit local run and exposes status/result without a daemon command API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-jobs-cli-')); dirs.push(root); const helper = join(root, 'helper.js'); await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(helper, ts.transpileModule(await readFile(new URL('./jobs.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, { mode: 0o600 });
  const results: string[] = [], options = { cwd: root, env: { GRUNT_JOBS_STATE_DIR: join(root, 'state') }, notify: (text: string) => { results.push(text); }, helperEntry: helper };
  expect(await jobsCommand(['run', '--category', 'test', '--timeout', '2', '--', process.execPath, '-e', 'process.stdout.write("cli-ok")'], options)).toBe(0);
  const final = JSON.parse(results.at(-1)!); expect(final).toMatchObject({ state: 'completed', stdout: 'cli-ok', category: 'test' });
  await jobsCommand(['result', final.id], options); expect(JSON.parse(results.at(-1)!)).toMatchObject({ state: 'completed', stdout: 'cli-ok' });
  await jobsCommand(['status'], options); const snapshot = JSON.parse(results.at(-1)!); expect(snapshot.sessions).toHaveLength(1); expect(JSON.stringify(snapshot)).not.toContain('process.stdout');
  await expect(jobsCommand(['start', '--', 'echo'], options)).rejects.toThrow('Usage:'); await expect(jobsCommand(['run', '--cwd', '/other', '--', 'echo'], options)).rejects.toThrow('Usage:');
});
