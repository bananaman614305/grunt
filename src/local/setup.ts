import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ProvisionInput } from '@trusty-squire/sdk';
import { freeConfig, loopback } from './freellmapi.js';
import { proxyApproval } from './approval-proxy.js';

const exec = promisify(execFile);
export const FREELLMAPI_IMAGE = 'ghcr.io/tashfeenahmed/freellmapi@sha256:845a4b568a20fffd5112e1b9c0258e7782d9eabbba2430612d2f7c811eee267e';
const PROVIDERS: Record<string, string> = { groq: 'https://console.groq.com/keys' };
export type Provider = keyof typeof PROVIDERS;
type Credential = { service: string | null; reference: string; field_names: string[]; auth_strategy?: string | null };
const sameService = (credential: Credential, service: string) => credential.service?.trim().toLowerCase() === service.trim().toLowerCase();
function apiKeyField(credential: Credential, provider: Provider): string | undefined {
  return credential.field_names.find(field => {
    const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');
    const name = normalized.startsWith(provider) ? normalized.slice(provider.length) : normalized;
    return ['apikey', 'key', 'token', 'value', 'secret', 'apitoken', 'accesstoken'].includes(name);
  });
}
type Run = { run: { id: string; state: string }; decision: 'silent' | 'needs_approval' | 'reject' | 'drop'; approval_url?: string; reason?: string };
// Select only diagnostic text, never serialize the browser result or vault data.
function setupReason(...values: unknown[]): string {
  return [...new Set(values.filter((value): value is string => typeof value === 'string')
    // Free-form secret descriptions cannot be redacted reliably. Drop the whole
    // field, including ambiguous prose, while retaining separate safe details.
    .filter(value => !/(?:password|passcode|token|secret|key|credential|authorization)/i.test(value.normalize('NFKC'))).map(value => value
    .replace(/\p{Cc}|\p{Cf}/gu, ' ')
    .replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted authorization]')
    .replace(/\b(?:gsk_|nvapi-|sk-|sk_|freellmapi-|ghp_)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' ').slice(0, 512);
}
function setupStopped(message: string, ...values: unknown[]): Error {
  const reason = setupReason(...values);
  return new Error(reason ? `${message}: ${reason}` : message);
}
// The browser adapter implements this narrow setup contract. It does not use
// the SDK's legacy runs API: signup is driven by local operate_drive calls.
export interface SetupSquire {
  credentials: {
    list(): Promise<Credential[]>;
    requestReveal(input: { reference: string; field?: string }): Promise<{ approval: { id: string; approveUrl: string; ready?: boolean } }>;
    claimReveal(id: string): Promise<{ value: string | null; fields: Record<string, string> }>;
  };
  runs: { start(input: ProvisionInput): Promise<Run>; get(id: string): Promise<{ state: string; approval_url?: string; reason?: string }> };
}
export class SetupPending extends Error {}
export async function setupProviders(squire: SetupSquire, router: { addKey(platform: string, key: string): Promise<void> }, options: { providers?: Provider[]; notify: (line: string) => void } ) {
  const pending: string[] = [];
  const dropped: string[] = [];
  const drop = (provider: string, reason?: string) => {
    const safe = setupReason(reason);
    options.notify(`${provider}: dropped; Squire cannot complete signup automatically${safe ? `: ${safe}` : ''}`);
    dropped.push(provider);
  };
  for (const provider of options.providers ?? Object.keys(PROVIDERS) as Provider[]) {
    const find = async () => (await squire.credentials.list()).find(c => sameService(c, provider) && c.auth_strategy !== 'username_password' && apiKeyField(c, provider));
    let credential = await find();
    if (!credential) {
      const result = await squire.runs.start({ service: provider, plan: 'free', project_name: 'Milo', category: 'ai', cost_cents: 0, recurrence: 'none', idempotency_key: `milo-free-${provider}` });
      if (result.decision === 'reject') throw setupStopped(`Squire refused ${provider} signup; setup stopped`, result.reason);
      if (result.decision === 'needs_approval' || result.decision === 'drop') { drop(provider, result.reason); continue; }
      let state = result.run.state;
      let reason = result.reason;
      const deadline = Date.now() + 120000;
      while (!['completed', 'failed', 'rejected', 'dropped'].includes(state) && Date.now() < deadline) {
        const run = await squire.runs.get(result.run.id); state = run.state; reason = run.reason ?? reason;
        if (run.approval_url || state === 'awaiting_approval') { state = 'dropped'; break; }
        if (!['completed', 'dropped', 'failed', 'rejected'].includes(state)) await delay(1000);
      }
      if (state === 'failed' || state === 'rejected') throw setupStopped(`Squire could not provision ${provider}; setup stopped`, reason);
      if (state !== 'completed') { drop(provider, reason); continue; }
      credential = await find();
      if (!credential) { drop(provider, 'No provider access was created'); continue; }
    }
    const field = apiKeyField(credential, provider)!;
    const { approval } = await squire.credentials.requestReveal({ reference: credential.reference, field });
    if (!approval.ready) options.notify(`${provider}: approve loading the key into local FreeLLMAPI: ${approval.approveUrl}`);
    try {
      const revealed = await squire.credentials.claimReveal(approval.id);
      const key = revealed.value ?? revealed.fields[field];
      if (!key) throw new Error(`Squire returned no ${provider} key`);
      await router.addKey(provider, key);
      options.notify(`${provider}: connected`);
    } catch (error) { if (error instanceof SetupPending) pending.push(provider); else throw error; }
  }
  return { pending, dropped };
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
type PendingApproval = { id: string; approveUrl: string; reference: string; field?: string; createdAt: number; expiresAt: number };
type Revealed = { value: string | null; fields: Record<string, string> };
const approvalKey = (input: { reference: string; field?: string }) => JSON.stringify([input.reference, input.field ?? null]);
export class BrowserSquire implements SetupSquire {
  private client = new Client({ name: 'Milo setup', version: '0.1.0' });
  private sessions = new Map<string, string>();
  private approvals = new Map<string, PendingApproval>();
  private deliveries = new Map<string, Revealed>();
  private approvalsLoaded = false;
  private legacyStatePath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'milo', 'approvals.json');
  private statePath = join(process.env.MILO_CONFIG_DIR || dirname(this.legacyStatePath), 'approvals.json');
  private handoffs: { url: string; close(): void }[] = [];
  private async loadApprovals() {
    if (this.approvalsLoaded) return;
    let entries: unknown;
    // The selected location wins, including an empty list after delivery. Only
    // fall back when absent, so moving Milo state preserves pending approvals.
    for (const path of new Set([this.statePath, this.legacyStatePath])) {
      try { entries = JSON.parse(await readFile(path, 'utf8')); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read Milo approval state; setup stopped');
      }
    }
    if (entries !== undefined && !Array.isArray(entries)) throw new Error('Invalid Milo approval state; setup stopped');
    for (const value of (entries ?? []) as unknown[]) {
      const entry = object(value);
      if (typeof entry.id !== 'string' || typeof entry.approveUrl !== 'string' || typeof entry.reference !== 'string' || (entry.field !== undefined && typeof entry.field !== 'string') || typeof entry.createdAt !== 'number' || typeof entry.expiresAt !== 'number') throw new Error('Invalid Milo approval state; setup stopped');
      const approval: PendingApproval = { id: entry.id, approveUrl: entry.approveUrl, reference: entry.reference, ...(typeof entry.field === 'string' ? { field: entry.field } : {}), createdAt: entry.createdAt, expiresAt: entry.expiresAt };
      this.approvals.set(approvalKey(approval), approval);
    }
    this.approvalsLoaded = true;
  }
  private async saveApprovals() {
    // Persist only approval metadata. Delivered values stay in memory.
    const temporary = `${this.statePath}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify([...this.approvals.values()]), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.statePath);
    } catch { throw new Error('Cannot save Milo approval state; setup stopped'); }
  }
  private reveal(result: ObjectValue): Revealed {
    const fields = object(result.fields) as Record<string, string>;
    return { fields, value: Object.keys(fields).length === 1 ? Object.values(fields)[0]! : null };
  }
  async connect() {
    const bin = join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bin.js');
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      ...(process.env.MILO_SQUIRE_XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.MILO_SQUIRE_XDG_CONFIG_HOME } : {}),
      TRUSTY_SQUIRE_AGENT_IDENTITY: 'Milo setup'
    };
    // Squire owns its account binding and vault. Milo never reads its files.
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'server'], stderr: 'ignore', env });
    try { await this.client.connect(transport); await this.credentials.list(); }
    catch {
      await this.client.close().catch(() => {});
      throw new Error('Connect Trusty Squire separately, then rerun milo setup');
    }
  }
  async call(name: string, args: ObjectValue): Promise<ObjectValue> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 60000 }).catch(() => { throw new Error(`Squire ${name} is unavailable; resume setup after reconnecting Squire`); });
    if (result.isError) throw new Error(`Squire ${name} failed; inspect Squire for the required action`);
    if (result.structuredContent) return object(result.structuredContent);
    for (const part of result.content as { type: string; text?: string }[]) {
      if (part.type === 'text' && part.text) { try { return object(JSON.parse(part.text)); } catch { /* Do not echo upstream output. */ } }
    }
    throw new Error(`Squire ${name} returned an unsupported result`);
  }
  credentials = {
    list: async (): Promise<Credential[]> => {
      const result = await this.call('list_credentials', { fields: 'summary' });
      if (!Array.isArray(result.credentials)) throw new Error('Squire did not return vault metadata');
      return result.credentials as Credential[];
    },
    requestReveal: async (input: { reference: string; field?: string }): Promise<{ approval: { id: string; approveUrl: string; ready?: boolean } }> => {
      await this.loadApprovals();
      const cacheKey = approvalKey(input);
      let approval = this.approvals.get(cacheKey);
      if (approval && this.deliveries.has(approval.id)) return { approval: { ...approval, ready: true } };
      if (approval && approval.expiresAt > Date.now() && approval.createdAt <= Date.now()) {
        const result = await this.call('fetch_credential', { action: 'resume', approval_id: approval.id });
        if (result.status === 'credential_fetched') {
          this.deliveries.set(approval.id, this.reveal(result));
          return { approval: { ...approval, ready: true } };
        }
        if (result.status === 'approval_pending') return { approval };
        if (result.status !== 'credential_fetch_refused' || !/(?:^|_)(?:denied|expired|unknown|not_found|consumed)(?:_|$)/i.test(String(result.reason))) throw setupStopped('Squire refused key loading; setup stopped', result.reason);
        approval = undefined;
      } else if (approval) approval = undefined;
      if (!approval) {
        const result = await this.call('fetch_credential', { action: 'start', ...input, reason: 'Load into your local FreeLLMAPI; never logged or saved by Milo' });
        if (typeof result.approval_id !== 'string' || typeof result.approval_url !== 'string') throw new Error('Squire did not return a key-loading approval');
        const createdAt = Date.now(), expires = Date.parse(String(result.expires_at));
        approval = { id: result.approval_id, approveUrl: result.approval_url, ...input, createdAt, expiresAt: Number.isFinite(expires) ? expires : createdAt + 15 * 60 * 1000 };
        this.approvals.set(cacheKey, approval);
        await this.saveApprovals();
      }
      return { approval };
    },
    claimReveal: async (id: string) => {
      let revealed = this.deliveries.get(id);
      if (!revealed) {
        const result = await this.call('fetch_credential', { action: 'resume', approval_id: id });
        if (result.status === 'approval_pending') throw new SetupPending('Squire approval is pending');
        if (result.status !== 'credential_fetched') throw setupStopped('Squire refused key loading; setup stopped', result.reason);
        revealed = this.reveal(result);
      }
      for (const [key, approval] of this.approvals) if (approval.id === id) this.approvals.delete(key);
      await this.saveApprovals();
      this.deliveries.delete(id);
      return revealed;
    }
  };
  private async drive(provider: Provider): Promise<Run> {
    const session = this.sessions.get(provider);
    const result = await this.call('operate_drive', {
      ...(session ? { session_id: session } : { url: PROVIDERS[provider] }),
      goal: `Use the user's existing ${provider} account or sign up for the free plan without human signup assistance. Create one API key for Milo and store it in this user's Squire vault with service ${provider}. Use operate_extract to capture the key directly into the vault; never put its value in your answer. No paid plan, payment method, extra account or account switching. Stop this signup if SMS, phone verification, captcha, passkey or another step requires a human; report the reason without creating an approval link. Stop on provider refusal.`,
      facts: { plan: 'free', project_name: 'Milo' }, max_seconds: 45, max_steps: 60
    });
    if (typeof result.session_id === 'string') this.sessions.set(provider, result.session_id);
    const reason = setupReason(result.reason, result.remaining);
    const classification = [result.reason, result.remaining].filter(value => typeof value === 'string').join(' ').replace(/[_-]/g, ' ');
    const refusal = ['refused', 'rejected', 'denied', 'forbidden'].includes(String(result.status)) || /\b(?:refus(?:al|ed|es|ing)?|denied|prohibit(?:ed|s)?|not allowed|not permitted|forbidden|disallowed)\b/i.test(classification);
    if (refusal) throw setupStopped(`Provider refused ${provider} signup; setup stopped`, reason);
    if (result.status === 'complete') {
      const id = this.sessions.get(provider);
      if (id) { await this.call('operate_finish', { session_id: id, outcome: 'result', summary: 'Milo provider key stored in user vault' }); this.sessions.delete(provider); }
      return { run: { id: provider, state: 'completed' }, decision: 'silent' };
    }
    const humanStep = /\b(?:sms|phone|captcha|passkey|human(?: only| input| assistance)?)\b/i.test(`${String(result.field)} ${classification}`);
    if (!humanStep && (result.status === 'budget' || result.status === 'evaluate_timeout')) return { run: { id: provider, state: 'running' }, decision: 'silent' };
    this.sessions.delete(provider);
    return { run: { id: provider, state: 'dropped' }, decision: 'drop', reason: reason || 'Signup needs human input or could not be completed' };
  }
  async humanHandoff(session: string) {
    const share = await this.call('operate_share', { session_id: session });
    if (typeof share.url !== 'string') throw new Error('Squire returned no browser handoff link');
    const proxy = await proxyApproval(share.url); this.handoffs.push(proxy);
    return proxy.url;
  }
  runs = {
    start: async (input: ProvisionInput) => this.drive(input.service as Provider),
    get: async (id: string) => { const result = await this.drive(id as Provider); return { state: result.run.state, ...(result.approval_url ? { approval_url: result.approval_url } : {}), ...(result.reason ? { reason: result.reason } : {}) }; }
  };
  async close() { for (const handoff of this.handoffs) handoff.close(); await this.client.close(); }
}

export class FreeLLMAdmin {
  private token = '';
  readonly url: string;
  constructor(url = 'http://127.0.0.1:3001') { this.url = loopback(url).origin; }
  async call(path: string, body?: unknown, method = 'POST') {
    const response = await fetch(`${this.url}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`Local FreeLLMAPI setup returned HTTP ${response.status}`);
    return await response.json();
  }
  async login(password: string) { this.token = (await this.call('/auth/login', { email: 'milo@localhost.local', password })).token; }
  async addKey(platform: string, key: string) {
    const keys = await this.call('/keys', undefined, 'GET') as { id: number; platform: string; label: string }[];
    const existing = keys.find(k => k.platform === platform && k.label === 'Milo');
    if (existing) await this.call(`/keys/${existing.id}`, { key, enabled: true }, 'PATCH');
    else await this.call('/keys', { platform, key, label: 'Milo' });
  }
  async configureChain(excluded: string[] = []) {
    const chain = await this.call('/fallback', undefined, 'GET') as { modelDbId: number; platform: string; modelId: string; priority: number; keyLabel: string | null }[];
    const rows = chain.map(row => ({ modelDbId: row.modelDbId,
      enabled: (!excluded.includes(row.platform) && row.platform in PROVIDERS) || (row.platform === 'custom' && ['kilo-auto/free', 'freebuff'].includes(row.modelId)),
      priority: row.modelId === 'freebuff' ? 1000000 : row.modelId === 'kilo-auto/free' ? 999999 : Math.min(row.priority, 999000) }));
    await this.call('/fallback', rows, 'PUT');
    await this.call('/fallback/routing', { strategy: 'priority' }, 'PUT');
  }
  async key(): Promise<string> { return (await this.call('/settings/api-key', undefined, 'GET')).apiKey; }
}

type DockerRun = (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string }>;
export async function ensureRouter(password: string, encryption: string, run: DockerRun = argsWithEnv) {
  if (process.platform !== 'linux') throw new Error('Milo FreeLLMAPI installation currently requires Linux Docker host networking');
  let owner: string | undefined;
  try { owner = (await run(['inspect', '--format', '{{ index .Config.Labels "io.milo.router" }}', 'milo-freellmapi'])).stdout.trim(); }
  catch (error) {
    if (!/No such (object|container)/i.test(String((error as { stderr?: string }).stderr))) throw new Error('Docker is unavailable; start Docker and resume milo setup');
  }
  if (owner !== undefined) {
    if (owner !== '1') throw new Error('The milo-freellmapi container belongs to another installation; setup stopped');
    await run(['start', 'milo-freellmapi']); return;
  }
  await run(['pull', FREELLMAPI_IMAGE]);
  // Docker copies named variables from env, keeping secrets out of argv.
  await run(['run', '-d', '--name', 'milo-freellmapi', '--label', 'io.milo.router=1', '--network', 'host', '--restart', 'unless-stopped', '-v', 'milo-freellmapi-data:/app/server/data', '-e', 'HOST=127.0.0.1', '-e', 'PORT=3001', '-e', 'ENCRYPTION_KEY', '-e', 'FREEAPI_CONFIG_JSON', FREELLMAPI_IMAGE], {
    ...process.env, ENCRYPTION_KEY: encryption, FREEAPI_CONFIG_JSON: JSON.stringify({ admin: { email: 'milo@localhost.local', password }, ...freeConfig() })
  });
}
async function argsWithEnv(args: string[], env?: NodeJS.ProcessEnv) {
  return await exec('docker', args, { timeout: 300000, maxBuffer: 1048576, ...(env ? { env } : {}) });
}
export async function setup(notify = console.log) {
  const squire = new BrowserSquire();
  const router = new FreeLLMAdmin();
  try {
    await squire.connect();
    const existing = (await squire.credentials.list()).find(c => sameService(c, 'milo-freellmapi-admin'));
    let password: string, encryption: string;
    if (existing) {
      const { approval } = await squire.credentials.requestReveal({ reference: existing.reference });
      if (!approval.ready) {
        notify(`Approve local FreeLLMAPI access: ${approval.approveUrl}`);
        await enter('Press Enter after approving in Squire. ');
      }
      const revealed = await squire.credentials.claimReveal(approval.id);
      password = revealed.fields.password!;
      encryption = revealed.fields.encryption_key!;
      if (!password || !encryption) throw new Error('Squire returned incomplete local FreeLLMAPI credentials');
    } else {
      password = randomBytes(32).toString('hex');
      encryption = randomBytes(32).toString('hex');
      await squire.call('store_credential', { service: 'milo-freellmapi-admin', fields: { password, encryption_key: encryption }, label: 'Milo local router' });
    }
    await ensureRouter(password, encryption);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await router.login(password); ready = true; break; } catch { await delay(1000); }
    }
    if (!ready) throw new Error('Local FreeLLMAPI did not start; inspect its health before resuming setup');
    await router.configureChain();
    let result = await setupProviders(squire, router, { notify });
    const dropped = new Set(result.dropped);
    while (result.pending.length) {
      notify(`Pending providers: ${result.pending.join(', ')}`);
      await enter('Complete the Squire vault approvals, then press Enter to resume. ');
      result = await setupProviders(squire, router, { providers: result.pending as Provider[], notify });
      for (const provider of result.dropped) dropped.add(provider);
    }
    await router.configureChain([...dropped]);
    return { key: await router.key() };
  } catch (error) {
    // Child-process and SDK errors may contain request data. Keep those local.
    if (error instanceof SetupPending) throw new Error('Squire approval remains pending; resume milo setup after approval');
    if (error instanceof Error && !('cmd' in error)) throw error;
    throw new Error('FreeLLMAPI installation failed; check Docker availability and resume milo setup');
  } finally { await squire.close(); }
}
async function enter(prompt: string) {
  if (!process.stdin.isTTY) throw new Error('Setup needs an interactive terminal to resume Squire approvals');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { await terminal.question(prompt); } finally { terminal.close(); }
}
