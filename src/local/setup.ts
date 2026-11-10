import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ProvisionInput } from '@trusty-squire/sdk';
import { freeConfig, loopback } from './freellmapi.js';
import { proxyApproval } from './approval-proxy.js';

const exec = promisify(execFile);
export const FREELLMAPI_IMAGE = 'ghcr.io/tashfeenahmed/freellmapi@sha256:845a4b568a20fffd5112e1b9c0258e7782d9eabbba2430612d2f7c811eee267e';
const PROVIDERS = { groq: 'https://console.groq.com/keys', mistral: 'https://console.mistral.ai/api-keys', nvidia: 'https://build.nvidia.com/' };
export type Provider = keyof typeof PROVIDERS;
type Credential = { service: string | null; reference: string; field_names: string[]; auth_strategy?: string | null };
type Run = { run: { id: string; state: string }; decision: 'silent' | 'needs_approval' | 'reject'; approval_url?: string };
// The browser adapter implements this narrow setup contract. It does not use
// the SDK's legacy runs API: signup is driven by local operate_drive calls.
export interface SetupSquire {
  credentials: {
    list(): Promise<Credential[]>;
    requestReveal(input: { reference: string; field?: string }): Promise<{ approval: { id: string; approveUrl: string } }>;
    claimReveal(id: string): Promise<{ value: string | null; fields: Record<string, string> }>;
  };
  runs: { start(input: ProvisionInput): Promise<Run>; get(id: string): Promise<{ state: string; approval_url?: string }> };
}
export class SetupPending extends Error {}
export async function setupProviders(squire: SetupSquire, router: { addKey(platform: string, key: string): Promise<void> }, options: { providers?: Provider[]; notify: (line: string) => void } ) {
  const pending: string[] = [];
  for (const provider of options.providers ?? Object.keys(PROVIDERS) as Provider[]) {
    const find = async () => (await squire.credentials.list()).find(c => c.service === provider && c.auth_strategy !== 'username_password' && c.field_names.some(f => /^(api_key|key|token|value)$/i.test(f)));
    let credential = await find();
    if (!credential) {
      const result = await squire.runs.start({ service: provider, plan: 'free', project_name: 'Milo', category: 'ai', cost_cents: 0, recurrence: 'none', idempotency_key: `milo-free-${provider}` });
      if (result.decision === 'reject') throw new Error(`Squire refused ${provider} signup; setup stopped`);
      if (result.decision === 'needs_approval') {
        if (!result.approval_url) throw new Error(`Squire needs human input for ${provider} but returned no approval link; setup stopped`);
        options.notify(`${provider}: approve in Squire: ${result.approval_url}`); pending.push(provider); continue;
      }
      let state = result.run.state;
      const deadline = Date.now() + 120000;
      while (!['completed', 'failed', 'rejected'].includes(state) && Date.now() < deadline) {
        const run = await squire.runs.get(result.run.id); state = run.state;
        if (run.approval_url) { options.notify(`${provider}: approve in Squire: ${run.approval_url}`); break; }
        if (state !== 'completed') await delay(1000);
      }
      if (state === 'failed' || state === 'rejected') throw new Error(`Squire could not provision ${provider}; setup stopped`);
      credential = await find();
      if (!credential) { pending.push(provider); options.notify(`${provider}: Squire signup is pending; resume setup after completing its approval`); continue; }
    }
    const field = credential.field_names.find(f => /^(api_key|key|token|value)$/i.test(f))!;
    const { approval } = await squire.credentials.requestReveal({ reference: credential.reference, field });
    options.notify(`${provider}: approve loading the key into local FreeLLMAPI: ${approval.approveUrl}`);
    try {
      const revealed = await squire.credentials.claimReveal(approval.id);
      const key = revealed.value ?? revealed.fields[field];
      if (!key) throw new Error(`Squire returned no ${provider} key`);
      await router.addKey(provider, key);
      options.notify(`${provider}: connected`);
    } catch (error) { if (error instanceof SetupPending) pending.push(provider); else throw error; }
  }
  return { pending };
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
export class BrowserSquire implements SetupSquire {
  private client = new Client({ name: 'Milo setup', version: '0.1.0' });
  private sessions = new Map<string, string>();
  private approvals = new Map<string, { id: string; approveUrl: string }>();
  private handoffs: { url: string; close(): void }[] = [];
  async connect() {
    const bin = join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bin.js');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), TRUSTY_SQUIRE_AGENT_IDENTITY: 'Milo setup' };
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'server'], stderr: 'ignore', env });
    try { await this.client.connect(transport); await this.credentials.list(); }
    catch {
      await this.client.close().catch(() => {});
      // Squire owns its account binding and vault. Milo never reads its files.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [bin, 'connect'], { stdio: 'inherit' });
        child.once('error', () => reject(new Error('Squire connection failed')));
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('Squire connection was not completed')));
      });
      this.client = new Client({ name: 'Milo setup', version: '0.1.0' });
      const retry = new StdioClientTransport({ command: process.execPath, args: [bin, 'server'], stderr: 'ignore', env });
      await this.client.connect(retry);
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
    requestReveal: async (input: { reference: string; field?: string }) => {
      const cacheKey = JSON.stringify(input);
      let approval = this.approvals.get(cacheKey);
      if (!approval) {
        const result = await this.call('fetch_credential', { action: 'start', ...input, reason: 'Load into your local FreeLLMAPI; never logged or saved by Milo' });
        if (typeof result.approval_id !== 'string' || typeof result.approval_url !== 'string') throw new Error('Squire did not return a key-loading approval');
        approval = { id: result.approval_id, approveUrl: result.approval_url }; this.approvals.set(cacheKey, approval);
      }
      return { approval };
    },
    claimReveal: async (id: string) => {
      const result = await this.call('fetch_credential', { action: 'resume', approval_id: id });
      if (result.status === 'approval_pending') throw new SetupPending('Squire approval is pending');
      if (result.status !== 'credential_fetched') throw new Error('Squire refused key loading; setup stopped');
      for (const [key, approval] of this.approvals) if (approval.id === id) this.approvals.delete(key);
      const fields = object(result.fields) as Record<string, string>;
      return { fields, value: Object.keys(fields).length === 1 ? Object.values(fields)[0]! : null };
    }
  };
  private async drive(provider: Provider): Promise<Run> {
    const session = this.sessions.get(provider);
    const result = await this.call('operate_drive', {
      ...(session ? { session_id: session } : { url: PROVIDERS[provider] }),
      goal: `Use the user's existing ${provider} account or sign up for the free plan. Create one API key for Milo and store it in this user's Squire vault with service ${provider}. Use operate_extract to capture the key directly into the vault; never put its value in your answer. No paid plan, payment method, extra account or account switching. Surface SMS, passkey and other human-only steps for approval. Stop on provider refusal.`,
      facts: { plan: 'free', project_name: 'Milo' }, max_seconds: 45, max_steps: 60
    });
    if (typeof result.session_id === 'string') this.sessions.set(provider, result.session_id);
    if (/refus|denied|prohibit|not allowed|policy/i.test(`${result.reason ?? ''} ${result.remaining ?? ''}`)) throw new Error(`Provider refused ${provider} signup; setup stopped`);
    if (result.status === 'complete') {
      const id = this.sessions.get(provider);
      if (id) { await this.call('operate_finish', { session_id: id, outcome: 'result', summary: 'Milo provider key stored in user vault' }); this.sessions.delete(provider); }
      return { run: { id: provider, state: 'completed' }, decision: 'silent' };
    }
    if (result.status === 'budget' || result.status === 'evaluate_timeout') return { run: { id: provider, state: 'running' }, decision: 'silent' };
    if (typeof result.approval_url === 'string') return { run: { id: provider, state: 'awaiting_approval' }, decision: 'needs_approval', approval_url: result.approval_url };
    const id = this.sessions.get(provider);
    if (id && ['needs_value', 'pending_approval', 'stuck', 'low_confidence', 'no_progress'].includes(String(result.status))) {
      return { run: { id: provider, state: 'awaiting_approval' }, decision: 'needs_approval', approval_url: await this.humanHandoff(id) };
    }
    // Never convert an unknown wall or a refusal into endless browser retries.
    throw new Error(`Squire signup for ${provider} needs attention (${String(result.status)}); no approval link was returned`);
  }
  async humanHandoff(session: string) {
    const share = await this.call('operate_share', { session_id: session });
    if (typeof share.url !== 'string') throw new Error('Squire returned no browser handoff link');
    const proxy = await proxyApproval(share.url); this.handoffs.push(proxy);
    return proxy.url;
  }
  runs = {
    start: async (input: ProvisionInput) => this.drive(input.service as Provider),
    get: async (id: string) => { const result = await this.drive(id as Provider); return { state: result.run.state, ...(result.approval_url ? { approval_url: result.approval_url } : {}) }; }
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
  async configureChain() {
    const chain = await this.call('/fallback', undefined, 'GET') as { modelDbId: number; platform: string; modelId: string; priority: number; keyLabel: string | null }[];
    const rows = chain.map(row => ({ modelDbId: row.modelDbId,
      enabled: row.platform in PROVIDERS || (row.platform === 'custom' && ['kilo-auto/free', 'freebuff'].includes(row.modelId)),
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
    const existing = (await squire.credentials.list()).find(c => c.service === 'milo-freellmapi-admin');
    let password: string, encryption: string;
    if (existing) {
      const { approval } = await squire.credentials.requestReveal({ reference: existing.reference });
      notify(`Approve local FreeLLMAPI access: ${approval.approveUrl}`);
      await enter('Press Enter after approving in Squire. ');
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
    while (result.pending.length) {
      notify(`Pending providers: ${result.pending.join(', ')}`);
      await enter('Complete the Squire approvals, close the browser handoff tab, then press Enter to resume. ');
      result = await setupProviders(squire, router, { providers: result.pending as Provider[], notify });
    }
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
