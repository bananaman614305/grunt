import { recordTransport } from './diagnostics.js';
import type { SafeDiagnosticMetadata } from './diagnostics.js';
import { configRoot } from '../brand.js';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SourceError } from './source.js';
import { FreebuffTools } from './freebuff-tools.js';
import type { Completion, ModelRequest, Source } from './source.js';

export const MISTRAL_VIBE_VERSION = '3.1.2';
export const MISTRAL_VIBE_MODEL = 'zai-glm-5-3-flash';
export const MISTRAL_VIBE_WIRE_MODEL = 'zai-glm-5-3-flash-vibe-free';
export const MISTRAL_VIBE_RECEIPT_MAX_AGE_MS = 30 * 86400000;
export interface MistralVibeFreePlanReceipt {
  version: 1;
  plan: 'Free';
  payAsYouGo: false;
  paymentMethodPresent: false;
  purchasedCredits: 0;
  checkedAt: string;
}
const configDirectory = () => configRoot();
export function mistralVibePaths(directory = configDirectory()) {
  const home = resolve(directory, 'mistral-vibe');
  return { home, binary: join(home, 'bin', process.platform === 'win32' ? 'vibe.exe' : 'vibe'), python: join(home, 'tools', 'mistral-vibe', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), work: join(home, 'work'), receipt: join(home, 'free-plan.json') };
}
// Native authentication remains CLI-owned. A shell's general Mistral API key
// must never silently replace this private Free Vibe login.
export function mistralVibeEnvironment(directory = configDirectory()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^vibe_/i.test(key) && !/^mistral_api_key$/i.test(key))), VIBE_HOME: mistralVibePaths(directory).home, VIBE_TEST_DISABLE_KEYRING: '1', PYTHON_KEYRING_BACKEND: 'keyring.backends.fail.Keyring' };
  delete env.MISTRAL_API_KEY;
  return env;
}
function validateReceipt(value: unknown): MistralVibeFreePlanReceipt {
  const receipt = value as Partial<MistralVibeFreePlanReceipt> | null;
  const checked = typeof receipt?.checkedAt === 'string' ? Date.parse(receipt.checkedAt) : NaN;
  if (!receipt || receipt.version !== 1 || receipt.plan !== 'Free' || receipt.payAsYouGo !== false || receipt.paymentMethodPresent !== false || receipt.purchasedCredits !== 0
      || !Number.isFinite(checked) || checked > Date.now() + 60000 || Date.now() - checked > MISTRAL_VIBE_RECEIPT_MAX_AGE_MS) {
    throw new SourceError('logged_out', 'Mistral Vibe Free plan verification is missing or expired; rerun usegrunt setup');
  }
  return receipt as MistralVibeFreePlanReceipt;
}
// This receipt records the browser's Free/billing check, not a new entitlement.
// Recheck it at least every 30 days; never enable overage billing during setup.
export async function readMistralVibeFreePlanReceipt(directory = configDirectory()) {
  const file = await open(mistralVibePaths(directory).receipt, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.size > 4096) throw new SourceError('logged_out', 'Unsafe Mistral Vibe plan receipt; rerun usegrunt setup');
    return validateReceipt(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
export async function writeMistralVibeFreePlanReceipt(directory: string, receipt: MistralVibeFreePlanReceipt) {
  const value = validateReceipt(receipt), paths = mistralVibePaths(directory), temporary = join(paths.home, `.free-plan-${randomUUID()}.tmp`);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, paths.receipt); }
  finally { await rm(temporary, { force: true }); }
}

export interface MistralVibeProcessResult { stdout: string; code: number | null }
// Each invocation has a private process group, so cancellation reaches its
// Python app server without touching other CLI sessions or browser processes.
export async function runMistralVibeProcess(binary: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; maxOutputBytes?: number; onStdout?: (chunk: string) => void;
}): Promise<MistralVibeProcessResult> {
  options.signal.throwIfAborted();
  const started = performance.now();
  return await new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', bytes = 0, oversized = false, failed = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { /* Our process group has already stopped. */ }
    };
    const abort = () => { kill('SIGTERM'); force ??= setTimeout(() => kill('SIGKILL'), 1000); };
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 16 * 1024 * 1024)) { oversized = true; stdout = ''; kill('SIGKILL'); return; }
      const text = chunk.toString(); stdout += text; options.onStdout?.(text);
    });
    // Never relay native stderr: authentication URLs and provider error payloads
    // can contain credentials. The structured export gives sanitized outcomes.
    child.stderr.resume();
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      options.signal.removeEventListener('abort', abort); if (force) clearTimeout(force);
      // A wrapper may exit before its child. Reap only the group we launched.
      if (options.signal.aborted) kill('SIGKILL');
      recordTransport({ source: 'mistral-vibe', transport: 'cli', endpointLabel: 'cli', durationMs: Math.max(0, performance.now() - started),
        outcome: options.signal.aborted ? 'cancelled' : failed || oversized || code !== 0 ? 'failed' : 'passed',
        ...(Number.isInteger(code) ? { exitCode: code! } : {}) });
      if (options.signal.aborted) reject(options.signal.reason);
      else if (failed) reject(new SourceError('not_installed', 'Mistral Vibe CLI could not start; rerun usegrunt setup'));
      else if (oversized) reject(new SourceError('upstream', 'Mistral Vibe output exceeded the supported size'));
      else resolveResult({ stdout, code });
    });
  });
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const invalidCompletion = (message: string, failureReason: SafeDiagnosticMetadata['failureReason']) =>
  new SourceError('upstream', message, undefined, undefined, { transport: 'cli', endpointLabel: 'cli', ...(failureReason ? { failureReason } : {}) });
// These outcomes map to exit 3 in the pinned Vibe export. Provider messages
// can inform routing but must never become diagnostic metadata.
const nativeStopOutcomes = ['turn_limit', 'token_limit', 'price_limit', 'deadline', 'terminated', 'length', 'refusal'] as const;
function nativeFailure(value: ObjectValue, exitCode?: number | null) {
  const error = object(value.error), hint = `${typeof error.code === 'string' ? error.code : ''} ${typeof error.message === 'string' ? error.message : ''}`;
  const code = /quota|rate.?limit|budget|credits?.*(?:exhaust|insufficient)|payment.required|429|402/i.test(hint) ? 'quota'
    : /unauthori|authenticat|sign.?in|logged.?out|invalid.?key|401/i.test(hint) ? 'logged_out'
      : value.outcome === 'deadline' ? 'timeout' : value.outcome === 'refusal' ? 'refused' : 'upstream';
  const reportedExitCode = exitCode ?? value.exit_code;
  const failureReason = reportedExitCode === 3 && value.exit_code === 3
    ? nativeStopOutcomes.find(outcome => outcome === value.outcome) : undefined;
  return new SourceError(code, `Mistral Vibe request failed (${code}); check the native Free plan or rerun usegrunt setup`, undefined, undefined,
    { transport: 'cli', endpointLabel: 'cli',
      ...(typeof reportedExitCode === 'number' && Number.isInteger(reportedExitCode) ? { exitCode: reportedExitCode } : {}),
      ...(failureReason ? { failureReason } : {}) });
}
export function parseMistralVibeCompletion(stdout: string, exported: unknown): Completion {
  const run = object(exported), config = object(run.config), models = object(config.models), selected = object(models[MISTRAL_VIBE_MODEL]);
  const providers = Array.isArray(config.providers) ? config.providers.map(object) : [];
  const provider = providers.find(row => row.name === 'mistral');
  if (config.active_model !== MISTRAL_VIBE_MODEL || selected.name !== MISTRAL_VIBE_WIRE_MODEL || selected.provider !== 'mistral'
      || selected.max_context_length !== 262144 || selected.auto_compact_threshold !== 202144
      || object(config.compaction_model).name !== MISTRAL_VIBE_WIRE_MODEL || object(config.compaction_model).provider !== 'mistral'
      || provider?.api_base !== 'https://api.mistral.ai/v1') throw invalidCompletion('Mistral Vibe did not use the vetted Free GLM model', 'completion_model');
  if (run.outcome !== 'finished' || run.exit_code !== 0 || run.error) throw nativeFailure(run);
  let history: unknown;
  try { history = JSON.parse(stdout); } catch { throw invalidCompletion('Mistral Vibe returned invalid completion JSON', 'response_json'); }
  if (!Array.isArray(history)) throw invalidCompletion('Mistral Vibe returned invalid completion history', 'response_body');
  const entries = history.map(object);
  if (entries.some(entry => entry.type === 'effect' || (Array.isArray(entry.content) && entry.content.some(part => /tool_call|tool_use/.test(String(object(part).type)))))) {
    throw new SourceError('refused', 'Mistral Vibe attempted native tools during a text-only completion', undefined, undefined,
      { transport: 'cli', endpointLabel: 'cli', failureReason: 'response_tools' });
  }
  const answer = [...entries].reverse().find(entry => entry.type === 'message' && entry.role === 'assistant' && entry.generationStatus === 'completed'
    && object(entry.outcome).type !== 'discarded' && Array.isArray(entry.content));
  const text = Array.isArray(answer?.content) ? answer.content.map(object).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n\n') : '';
  const usage = object(run.usage);
  if (!text.trim()) throw invalidCompletion('Mistral Vibe returned no complete answer or valid native usage', 'response_content');
  if (!Number.isSafeInteger(usage.input_tokens) || Number(usage.input_tokens) < 0 || !Number.isSafeInteger(usage.output_tokens) || Number(usage.output_tokens) < 0)
    throw invalidCompletion('Mistral Vibe returned no complete answer or valid native usage', 'completion_usage');
  return { text, inputTokens: usage.input_tokens as number, outputTokens: usage.output_tokens as number };
}
export class MistralVibe implements Source {
  readonly id = 'mistral-vibe';
  readonly supportsFunctionTools = true;
  private shutdown = new AbortController();
  private pending = new Set<Promise<unknown>>();
  constructor(private options: { directory?: string; binary?: string; timeout?: number } = {}) {}
  private async ready() {
    const paths = mistralVibePaths(this.options.directory);
    try {
      await readMistralVibeFreePlanReceipt(this.options.directory);
      const home = await lstat(paths.home), auth = await lstat(join(paths.home, '.env'));
      if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid?.() || (home.mode & 0o077) !== 0
          || !auth.isFile() || auth.isSymbolicLink() || auth.uid !== process.getuid?.() || (auth.mode & 0o777) !== 0o600 || auth.size === 0) throw new Error('Unsafe native auth');
      await access(this.options.binary ?? paths.binary, constants.X_OK);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError('logged_out', 'Mistral Vibe Free login is unavailable; rerun usegrunt setup');
    }
    return paths;
  }
  async available() { try { await this.ready(); return !this.shutdown.signal.aborted; } catch { return false; } }
  async healthCheck() { return this.available(); }
  async complete(request: ModelRequest, caller: AbortSignal) {
    caller.throwIfAborted();
    if (request.imageInput) throw new SourceError('refused', 'Mistral Vibe does not support image inputs through this route');
    const task = this.completeBridged(request, caller); this.pending.add(task);
    try { return await task; }
    catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Mistral Vibe request cancelled during shutdown');
      if (error instanceof SourceError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') throw new SourceError('timeout', 'Mistral Vibe request timed out');
      throw new SourceError('upstream', 'Mistral Vibe request failed');
    } finally { this.pending.delete(task); }
  }
  private async completeBridged(request: ModelRequest, caller: AbortSignal): Promise<Completion> {
    const needsBridge = request.tools.length > 0 || request.messages.some(message => message.role === 'tool' || message.tool_calls?.length);
    if (!needsBridge) return await this.completeText(request, caller);
    let bridge: FreebuffTools;
    try { bridge = new FreebuffTools(request); }
    catch { throw new SourceError('refused', 'Mistral Vibe rejected unsupported tool definitions or an invalid tool conversation'); }
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 180000)]);
    let inputTokens = 0, outputTokens = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const handoffPrompt = bridge.prompt(attempt > 0).replace('native Freebuff tools', 'native Mistral Vibe tools');
      const result = await this.completeText({ ...request, handoffPrompt }, signal);
      inputTokens += result.inputTokens ?? 0; outputTokens += result.outputTokens ?? 0;
      try { return { ...bridge.parse(result.text), inputTokens, outputTokens }; }
      catch { if (attempt === 1) throw invalidCompletion('Mistral Vibe tool response failed validation after one repair attempt', 'completion_protocol'); }
    }
    throw new SourceError('upstream', 'Mistral Vibe tool protocol failed');
  }
  private async completeText(request: ModelRequest, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.shutdown.signal, AbortSignal.timeout(this.options.timeout ?? 180000)]);
    let temporary: string | undefined;
    try {
      signal.throwIfAborted(); const paths = await this.ready(); signal.throwIfAborted();
      await mkdir(paths.work, { recursive: true, mode: 0o700 });
      temporary = await mkdtemp(join(paths.home, '.request-')); await chmod(temporary, 0o700);
      const prompt = request.handoffPrompt ?? (request.messages.length === 1 && request.messages[0]?.role === 'user' ? request.messages[0].content
        : `Continue this conversation and answer the latest user request. The following JSON is the complete conversation, including its system and developer instructions:\n${JSON.stringify(request.messages)}`);
      if (!prompt.trim()) throw new SourceError('upstream', 'No text in the Mistral Vibe request');
      const promptFile = join(temporary, 'prompt.txt'), output = join(temporary, 'export');
      await writeFile(promptFile, prompt, { mode: 0o600, flag: 'wx' });
      const cap = Math.min(4096, Math.max(1, Number.isFinite(request.maxTokens) ? Math.floor(request.maxTokens!) : 4096));
      const env: NodeJS.ProcessEnv = { ...mistralVibeEnvironment(this.options.directory),
        VIBE_ACTIVE_MODEL: MISTRAL_VIBE_MODEL, VIBE_ALLOWED_MODELS: JSON.stringify([MISTRAL_VIBE_WIRE_MODEL]),
        // These are the authenticated native Free preset's actual limits. Pin
        // the wire ID before inference; Vibe's non-admin allowlist fails open.
        VIBE_MODELS: JSON.stringify([{ name: MISTRAL_VIBE_WIRE_MODEL, alias: MISTRAL_VIBE_MODEL, provider: 'mistral', max_context_length: 262144, auto_compact_threshold: 202144, thinking: 'high', thinking_levels: ['low', 'high', 'max'] }]),
        VIBE_COMPACTION_MODEL: JSON.stringify({ name: MISTRAL_VIBE_WIRE_MODEL, alias: MISTRAL_VIBE_MODEL, provider: 'mistral', max_context_length: 262144, auto_compact_threshold: 202144, thinking: 'high', thinking_levels: ['low', 'high', 'max'] }),
        VIBE_UTILITY_MODELS: '{"title":"active","smart_approve":"active"}',
        VIBE_PROVIDERS: JSON.stringify([{ name: 'mistral', api_base: 'https://api.mistral.ai/v1', api_key_env_var: 'MISTRAL_API_KEY', backend: 'mistral', api_style: 'openai' }]),
        VIBE_AGENT_MAX_OUTPUT_TOKENS: String(cap), VIBE_OUTPUT_LIMIT_RETRIES: '0', VIBE_ENABLE_UPDATE_CHECKS: 'false',
        VIBE_ENABLE_MCP: 'false', VIBE_ENABLE_CONNECTORS: 'false', VIBE_ENABLE_SUBAGENTS: 'false', VIBE_DISABLED_TOOLS: '["*"]',
        VIBE_SESSION_LOGGING: '{"enabled":false,"generate_titles":false}' };
      // Vibe counts assistant history entries, including intermediate entries
      // before the finished answer. Keep the run bounded and all native tools off.
      const result = await runMistralVibeProcess(this.options.binary ?? paths.binary, ['--model', MISTRAL_VIBE_MODEL, '--disabled-tools', '*', '--prompt-file', promptFile,
        '--output', 'json', '--output-dir', output, '--max-turns', '2', '--time-limit', String(Math.max(1, Math.ceil((this.options.timeout ?? 180000) / 1000)))], { cwd: paths.work, env, signal });
      signal.throwIfAborted();
      let exported: unknown;
      try {
        const file = await open(join(output, 'export.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { if ((await file.stat()).size > 1024 * 1024) throw new Error('Oversized export'); exported = JSON.parse(await file.readFile('utf8')); }
        finally { await file.close(); }
      } catch { throw new SourceError('upstream', 'Mistral Vibe produced no readable completion export'); }
      if (result.code !== 0) throw nativeFailure(object(exported), result.code);
      const completion = parseMistralVibeCompletion(result.stdout, exported);
      if (completion.outputTokens! > cap) throw new SourceError('upstream', 'Mistral Vibe exceeded the aggregate output budget', undefined, undefined,
        { transport: 'cli', endpointLabel: 'cli', failureReason: 'token_limit' });
      return completion;
    } catch (error) {
      caller.throwIfAborted();
      if (this.shutdown.signal.aborted) throw new SourceError('cancelled', 'Mistral Vibe request cancelled during shutdown');
      if (signal.aborted) throw new SourceError('timeout', 'Mistral Vibe request timed out');
      if (error instanceof SourceError) throw error;
      throw new SourceError('upstream', 'Mistral Vibe request failed; rerun usegrunt setup');
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
  async close() { this.shutdown.abort(); await Promise.allSettled([...this.pending]); }
}
