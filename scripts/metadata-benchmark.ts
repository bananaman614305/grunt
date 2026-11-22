/** Offline metadata benchmark; all HTTP responses and credentials are synthetic. */
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { BeatAPI, BEATAPI_MODEL, BEATAPI_ORIGIN } from '../src/local/beatapi.js';
import { Darus, DARUS_HOST, DARUS_MODEL } from '../src/local/darus.js';
import { recordDataSharingConsent } from '../src/local/data-sharing.js';
import type { Completion, ModelRequest } from '../src/local/source.js';

interface MetadataSource {
  available(): Promise<boolean>;
  complete(request: ModelRequest, signal: AbortSignal): Promise<Completion>;
  close(): Promise<void>;
}
export interface MetadataRuntime {
  BeatAPI: new (options: ConstructorParameters<typeof BeatAPI>[0]) => MetadataSource;
  Darus: new (options: ConstructorParameters<typeof Darus>[0]) => MetadataSource;
}
const current: MetadataRuntime = { BeatAPI, Darus };
export interface MetadataMeasurement {
  provider: 'beatapi' | 'darus'; scenario: 'availability-burst' | 'availability-with-dispatch'; callers: number;
  metadataRequests: number; completionRequests: number; verifiedResults: number; elapsedMs: number;
  laterCheckFresh: boolean;
}
export async function measureMetadata(runtime: MetadataRuntime, provider: 'beatapi' | 'darus', callers = 8, dispatch = false): Promise<MetadataMeasurement> {
  if (!Number.isSafeInteger(callers) || callers < 2 || callers > 32) throw new Error('Use 2–32 metadata callers.');
  const directory = await mkdtemp(join(tmpdir(), 'grunt-metadata-benchmark-'));
  let source: MetadataSource | undefined, metadataRequests = 0, completionRequests = 0, loaded = 0;
  const expectedLoads = callers + Number(dispatch);
  let allLoaded!: () => void;
  const loadedGate = new Promise<void>(done => { allLoaded = done; });
  const countLoad = () => { if (++loaded === expectedLoads) allLoaded(); };
  try {
    await recordDataSharingConsent(directory, [provider]);
    const fetcher: typeof fetch = async url => {
      const path = String(url); if (path.endsWith('/completions')) completionRequests++; else metadataRequests++;
      await loadedGate;
      await new Promise<void>(done => setTimeout(done, 3));
      if (path.endsWith('/usage')) return Response.json({ data: { object: 'usage', credit_balance: 2, credits_settled: 0 } });
      if (path.endsWith('/models')) return Response.json({ data: [{ id: DARUS_MODEL, free: true, owned_by: 'Darus Gateway' }] });
      if (path.endsWith('/tpd')) return Response.json({ status: { eligible: true, protectBalance: true, day: new Date().toISOString().slice(0, 10),
        allowance: 10000000, used: 0, remaining: 10000000, balance: 0, multiplier: 1, tier: { key: 'FREE', tpd: 10000000, minBalance: 0 } } });
      if (!path.endsWith('/completions')) throw new Error('Unexpected synthetic endpoint.');
      return Response.json({ model: provider === 'beatapi' ? BEATAPI_MODEL : DARUS_MODEL,
        choices: [{ message: { content: 'verified fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    };
    source = provider === 'beatapi' ? new runtime.BeatAPI({ directory, fetcher, loadGrant: async () => {
      countLoad(); return { version: 1, base_url: 'https://trusty-squire-api.fly.dev/v1/egress/g_abcdefghijklmnop', token: 'synthetic-private-grant', upstream_origin: BEATAPI_ORIGIN,
        model: BEATAPI_MODEL, verified_at: new Date().toISOString(), free_account_verified: true, lifetime_paid: 0, payment_method_present: false,
        auto_recharge: false, credit_provenance: 'signup', baseline_balance: 2 };
    } }) : new runtime.Darus({ directory, fetcher, loadGrant: async () => {
      countLoad(); return { base_url: `https://${DARUS_HOST}`, token: 'synthetic-private-grant' };
    } });
    const started = performance.now(), pending = Array.from({ length: callers }, () => source!.available());
    const completion = dispatch ? source.complete({ model: provider, messages: [{ role: 'user', content: 'Synthetic fixture' }], tools: [], cwd: directory, stream: false }, AbortSignal.timeout(5000)) : undefined;
    const [availability, result] = await Promise.all([Promise.all(pending), completion]);
    if (availability.some(ok => !ok) || dispatch && result?.text !== 'verified fixture') throw new Error('Metadata benchmark result verification failed.');
    const measurement: MetadataMeasurement = { provider, scenario: dispatch ? 'availability-with-dispatch' : 'availability-burst', callers: expectedLoads,
      metadataRequests, completionRequests, verifiedResults: availability.length + Number(dispatch), elapsedMs: performance.now() - started, laterCheckFresh: false };
    // A separate adapter instance is unnecessary: Darus always rechecks and BeatAPI
    // keeps its required inference cooldown. Only availability-only bursts can
    // perform a follow-up check without changing quota or time.
    if (!dispatch || provider === 'darus') {
      const before = metadataRequests;
      if (!await source.available() || metadataRequests <= before) throw new Error('Later metadata evidence was cached.');
      measurement.laterCheckFresh = true;
    }
    return measurement;
  } finally { allLoaded(); await source?.close(); await rm(directory, { recursive: true, force: true }); }
}
export async function runMetadataBenchmark(args: string[]) {
  let baseline: string | undefined, iterations = 5, callers = 8;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value) throw new Error('Usage: metadata-benchmark.ts [--baseline /trusted/checkout] [--iterations 1–20] [--callers 2–32]');
    if (flag === '--baseline') baseline = value;
    else if (flag === '--iterations') iterations = Number(value);
    else if (flag === '--callers') callers = Number(value);
    else throw new Error('Unknown metadata benchmark option.');
  }
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20 || !Number.isSafeInteger(callers) || callers < 2 || callers > 32) throw new Error('Invalid metadata benchmark bounds.');
  const identity = async (root: string) => Object.fromEntries(await Promise.all(['beatapi.ts', 'darus.ts', 'metadata-flight.ts'].map(async file =>
    [file, createHash('sha256').update(await readFile(join(root, 'src/local', file))).digest('hex')])));
  const sourceIdentity = { current: await identity(resolve(fileURLToPath(new URL('..', import.meta.url)))) } as { current: Record<string, string>; baseline?: Record<string, string> };
  let before: MetadataRuntime | undefined;
  if (baseline) {
    const root = await realpath(resolve(baseline));
    sourceIdentity.baseline = await identity(root);
    // Explicit developer invocation trusts the local checkout code, never a URL.
    const [beat, darus] = await Promise.all([import(pathToFileURL(join(root, 'src/local/beatapi.ts')).href), import(pathToFileURL(join(root, 'src/local/darus.ts')).href)]);
    before = { BeatAPI: beat.BeatAPI, Darus: darus.Darus };
  }
  const measurements: Array<MetadataMeasurement & { implementation: string; iteration: number }> = [];
  const implementations = [...(before ? [{ name: 'baseline', runtime: before }] : []), { name: 'current', runtime: current }];
  for (let iteration = 0; iteration < iterations; iteration++) for (const impl of iteration % 2 ? [...implementations].reverse() : implementations) {
    for (const provider of ['beatapi', 'darus'] as const) for (const dispatch of [false, true]) {
      measurements.push({ implementation: impl.name, iteration, ...await measureMetadata(impl.runtime, provider, callers, dispatch) });
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const summaries = implementations.flatMap(impl => (['beatapi', 'darus'] as const).flatMap(provider => (['availability-burst', 'availability-with-dispatch'] as const).map(scenario => {
    const rows = measurements.filter(row => row.implementation === impl.name && row.provider === provider && row.scenario === scenario);
    return { implementation: impl.name, provider, scenario, completedRuns: rows.length, medianElapsedMs: median(rows.map(row => row.elapsedMs)),
      metadataRequestsPerRun: rows.map(row => row.metadataRequests), completionRequestsPerRun: rows.map(row => row.completionRequests), verifiedResultsPerRun: rows.map(row => row.verifiedResults) };
  })));
  return { version: 1, kind: 'offline-metadata-benchmark', iterations, callers, sourceIdentity, summaries, measurements,
    limitations: 'Synthetic fixed-delay transports; verified identical availability/completion results. Metadata request counts are exact; elapsed times include host load and filesystem consent reads. No network, live provider, game, account, or quota operations; no general coding-speed claim.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runMetadataBenchmark(process.argv.slice(2)); process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
