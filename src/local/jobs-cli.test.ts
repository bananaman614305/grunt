import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { jobsCommand } from './jobs-cli.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
it('executes only an explicit local run and exposes status/result without a daemon command API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-jobs-cli-')); dirs.push(root); const helper = join(root, 'helper.js'); await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(helper, ts.transpileModule(await readFile(new URL('./jobs.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, { mode: 0o600 });
  await writeFile(join(root, 'verification.js'), ts.transpileModule(await readFile(new URL('./verification.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, { mode: 0o600 });
  const results: string[] = [], options = { cwd: root, env: { GRUNT_JOBS_STATE_DIR: join(root, 'state') }, notify: (text: string) => { results.push(text); }, helperEntry: helper };
  expect(await jobsCommand(['run', '--category', 'test', '--timeout', '2', '--', process.execPath, '-e', 'process.stdout.write("cli-ok")'], options)).toBe(0);
  const final = JSON.parse(results.at(-1)!); expect(final).toMatchObject({ state: 'completed', stdout: 'cli-ok', category: 'test' });
  await jobsCommand(['result', final.id], options); expect(JSON.parse(results.at(-1)!)).toMatchObject({ state: 'completed', stdout: 'cli-ok' });
  await jobsCommand(['status'], options); const snapshot = JSON.parse(results.at(-1)!); expect(snapshot.sessions).toHaveLength(1); expect(JSON.stringify(snapshot)).not.toContain('process.stdout');
  await expect(jobsCommand(['start', '--', 'echo'], options)).rejects.toThrow('Usage:'); await expect(jobsCommand(['run', '--cwd', '/other', '--', 'echo'], options)).rejects.toThrow('Usage:');
});

it('returns a scoped content/artifact receipt from a real managed CLI command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-verify-cli-')); dirs.push(root); const project = join(root, 'project'); await mkdir(project);
  const git = (...args: string[]) => { const result = spawnSync('git', args, { cwd: project, encoding: 'utf8' }); expect(result.status).toBe(0); };
  git('init', '-q'); git('config', 'user.name', 'synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  await writeFile(join(project, '.gitignore'), 'dist/\n'); await writeFile(join(project, 'input'), 'synthetic'); git('add', '.'); git('commit', '-qm', 'fixture');
  await mkdir(join(project, 'dist')); await writeFile(join(project, 'dist/index.html'), 'verified');
  const helper = join(root, 'helper.js'); await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [source, target] of [['jobs.ts', 'helper.js'], ['verification.ts', 'verification.js']]) await writeFile(join(root, target!), ts.transpileModule(await readFile(new URL('./' + source, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  const results: string[] = [], options = { cwd: project, env: { GRUNT_JOBS_STATE_DIR: join(root, 'state') }, notify: (text: string) => { results.push(text); }, helperEntry: helper };
  expect(await jobsCommand(['run', '--check', 'unit', '--artifact', 'dist', '--', process.execPath, '-e', 'process.stdout.write("verified")'], options)).toBe(0);
  const result = JSON.parse(results.at(-1)!); expect(result.verification).toMatchObject({ mode: 'scoped', checkId: 'unit', state: 'completed', unchanged: true, after: { clean: true, artifactFiles: [{ path: 'dist/index.html' }] } });
  await jobsCommand(['result', result.id], options); expect(JSON.parse(results.at(-1)!).verification).toEqual(result.verification);
});
