/** Offline benchmark: node --import tsx scripts/verification-benchmark.ts [--baseline /absolute/verification.ts] */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../src/local/verification.js';
import type { VerificationPlan, VerificationReceipt } from '../src/local/verification.js';

const baselineIndex = process.argv.indexOf('--baseline');
if (process.argv.slice(2).some((argument, index, args) => argument !== '--baseline' && args[index - 1] !== '--baseline')
  || baselineIndex >= 0 && !process.argv[baselineIndex + 1]) throw new Error('Usage: verification-benchmark.ts [--baseline /absolute/verification.ts]');
const baseline: typeof current | undefined = baselineIndex < 0 ? undefined : await import(pathToFileURL(resolve(process.argv[baselineIndex + 1]!)).href);
const root = await mkdtemp(join(tmpdir(), 'grunt-verification-benchmark-'));
const project = join(root, 'project');
const git = (...args: string[]) => {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' } });
  if (result.status !== 0) throw new Error('Synthetic Git fixture failed.');
};
async function elapsed(work: () => Promise<unknown>) { const start = performance.now(); await work(); return performance.now() - start; }
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  await mkdir(project); await mkdir(join(project, 'assets'));
  for (let i = 0; i < 512; i++) await writeFile(join(project, 'assets', `synthetic-${i}.txt`), Buffer.alloc(16 * 1024, i % 251));
  git('init', '-q'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic benchmark');
  const state = await current.captureVerificationState(project, ['assets']);
  const plan: VerificationPlan = { version: 1, id: 'benchmark', mode: 'release', checks: Array.from({ length: 6 }, (_, index) => ({ id: `check-${index}`, command: `synthetic-${index}`, artifactPaths: ['assets'] })) };
  const key = randomBytes(32), now = Date.now();
  const receipts: VerificationReceipt[] = plan.checks.map((check, index) => current.signVerificationReceipt({ version: 1, id: `synthetic-${index}`, mode: 'release', checkId: check.id,
    planDigest: current.verificationPlanDigest(plan), commandDigest: current.verificationCommandDigest(check.command), state: 'completed', exitCode: 0,
    completedAt: now - 1, unchanged: true, before: state, after: state, environmentDigest: 'a'.repeat(64) }, key));
  if (baseline && !current.sameVerificationState(state, await baseline.captureVerificationState(project, ['assets']))) throw new Error('Baseline and current digests differ.');
  const implementations = [...(baseline ? [['baseline', baseline] as const] : []), ['current', current] as const];
  const measurements = implementations.map(([name, implementation]) => ({ name, implementation, capture: [] as number[], releasePlan: [] as number[] }));
  for (const row of measurements) await row.implementation.captureVerificationState(project, ['assets']);
  // Alternate the order to reduce warm-cache and changing host-load bias.
  for (let run = 0; run < 3; run++) for (const row of run % 2 ? [...measurements].reverse() : measurements) {
    row.capture.push(await elapsed(() => row.implementation.captureVerificationState(project, ['assets'])));
    row.releasePlan.push(await elapsed(() => row.implementation.verifyReleaseReceipts(receipts, plan, project, key, now)));
  }
  const results = measurements.map(row => ({ implementation: row.name, captureMilliseconds: row.capture, captureMedianMilliseconds: median(row.capture), sixCheckPlanMilliseconds: row.releasePlan, sixCheckPlanMedianMilliseconds: median(row.releasePlan) }));
  console.log(JSON.stringify({ scenario: '512 tracked 16-KiB artifacts; six authenticated checks sharing one artifact set; three warm repetitions', bytes: 512 * 16 * 1024,
    limitations: 'Offline filesystem benchmark only; no model, provider, game, or external check execution. Timing depends on filesystem/cache/load.', results }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
