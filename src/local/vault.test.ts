import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BeatAPI, BEATAPI_MODEL, BEATAPI_MODELS, BEATAPI_ORIGIN, readBeatAPIGrant, writeBeatAPIGrant } from './beatapi.js';
import type { BeatAPIGrant } from './beatapi.js';
import { setupBeatAPI } from './beatapi-setup.js';
import { recordDataSharingConsent } from './data-sharing.js';
import { DiagnosticsStore, withDiagnosticContext } from './diagnostics.js';
import { readFreeApiGrant } from './free-api.js';
import {
  Pollinations,
  POLLINATIONS_MODEL,
  POLLINATIONS_ORIGIN,
  POLLINATIONS_RETURNED_MODEL,
  readPollinationsGrant,
  writePollinationsGrant
} from './pollinations.js';
import type { PollinationsGrant } from './pollinations.js';
import { setupPollinations } from './pollinations-setup.js';
import { materializeDirectGrant, readPrivateProviderGrant, validatePinnedProviderGrant, writePrivateProviderGrant } from './provider-grant.js';
import { BrowserSquire, setupProviders } from './setup.js';
import {
  SQUIRE_EGRESS_ORIGIN,
  deleteVaultEntry,
  listVaultEntries,
  readVaultEntry,
  readVaultEnvGrant,
  readVaultGrant,
  redactVaultSecrets,
  validateDirectOrigin,
  validateProviderEndpoint,
  vaultEnvKeyName,
  vaultPath,
  writeVaultEntry
} from './vault.js';
import { vaultCommand } from './vault-cli.js';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-vault-test-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function startFakeUpstream(
  handler: (req: { method: string; url: string; authorization: string | undefined; body: string }) => { status?: number; headers?: Record<string, string>; body: unknown }
) {
  const seen: { method: string; url: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';
      const authorization = req.headers.authorization;
      seen.push({ method, url, authorization });
      const reply = handler({ method, url, authorization, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  };
}

function directBridgeFetcher(expectedOrigin: string, localServerOrigin: string): typeof fetch {
  return async (input, init) => {
    const requested = String(input);
    const parsed = new URL(requested);
    expect(parsed.origin).toBe(expectedOrigin);
    expect(requested).not.toContain('trusty-squire-api.fly.dev');
    return fetch(`${localServerOrigin}${parsed.pathname}${parsed.search}`, init);
  };
}

it('stores local vault entries with 0700 dir, 0600 file, atomic writes, and serialized updates', async () => {
  const nested = join(directory, 'private-config');
  await Promise.all([
    writeVaultEntry('beatapi', { api_key: 'sk-beatapi-synthetic-secret-1', source: 'local' }, nested),
    writeVaultEntry('pollinations', { api_key: 'sk-pollinations-synthetic-secret-2', source: 'import' }, nested),
    writeVaultEntry('darus', { api_key: 'sk-darus-synthetic-secret-3', source: 'squire' }, nested)
  ]);

  expect((await stat(nested)).mode & 0o777).toBe(0o700);
  expect((await stat(vaultPath(nested))).mode & 0o777).toBe(0o600);
  expect(await readdir(nested)).toEqual(['vault.json']);

  expect(await readVaultEntry('beatapi', nested)).toMatchObject({
    api_key: 'sk-beatapi-synthetic-secret-1',
    origin: BEATAPI_ORIGIN,
    source: 'local'
  });
  expect(await readVaultEntry('pollinations', nested)).toMatchObject({
    api_key: 'sk-pollinations-synthetic-secret-2',
    origin: POLLINATIONS_ORIGIN,
    source: 'import'
  });
  expect(await readVaultEntry('darus', nested)).toMatchObject({
    api_key: 'sk-darus-synthetic-secret-3',
    origin: 'https://gateway.darusalfatah.id',
    source: 'squire'
  });

  // Listing returns metadata only and never exposes secrets.
  const summaries = await listVaultEntries(nested, {});
  expect(summaries.map(item => item.provider)).toEqual(['beatapi', 'darus', 'pollinations']);
  const serialized = JSON.stringify(summaries);
  expect(serialized).not.toContain('sk-beatapi-synthetic-secret-1');
  expect(serialized).not.toContain('sk-pollinations-synthetic-secret-2');
  expect(serialized).not.toContain('sk-darus-synthetic-secret-3');

  expect(await deleteVaultEntry('darus', nested)).toBe(true);
  expect(await deleteVaultEntry('darus', nested)).toBe(false);
  expect(await readVaultEntry('darus', nested)).toBeUndefined();
});

it('rejects insecure vault permissions, symlinks, broad directories, and FIFOs', async () => {
  await writeVaultEntry('beatapi', { api_key: 'sk-beatapi-secret' }, directory);

  await chmod(vaultPath(directory), 0o644);
  await expect(readVaultGrant('beatapi', directory, {})).rejects.toThrow('Unsafe local vault file');

  await chmod(vaultPath(directory), 0o600);
  await chmod(directory, 0o755);
  await expect(readVaultGrant('beatapi', directory, {})).rejects.toThrow('Unsafe local vault directory');
  await chmod(directory, 0o700);

  const target = join(directory, 'real-vault.json');
  await writeFile(target, await readFile(vaultPath(directory), 'utf8'), { mode: 0o600 });
  await rm(vaultPath(directory));
  await symlink(target, vaultPath(directory));
  await expect(readVaultGrant('beatapi', directory, {})).rejects.toThrow('Unsafe local vault file');
  await rm(vaultPath(directory));

  if (process.platform !== 'win32') {
    execFileSync('mkfifo', ['-m', '600', vaultPath(directory)]);
    await expect(readVaultGrant('beatapi', directory, {})).rejects.toThrow('Unsafe local vault file');
  }
});

it('enforces strict per-provider HTTPS host pinning and rejects untrusted URLs', async () => {
  expect(validateDirectOrigin('beatapi', 'https://api.beatapi.io/')).toBe('https://api.beatapi.io');
  expect(validateDirectOrigin('aperture-ai', 'https://aperture-ai.run')).toBe('https://aperture-ai.run');
  expect(validateProviderEndpoint('beatapi', 'https://api.beatapi.io')).toEqual({
    base_url: 'https://api.beatapi.io',
    transport: 'direct'
  });
  expect(validateProviderEndpoint('beatapi', `${SQUIRE_EGRESS_ORIGIN}/v1/egress/g_${'a'.repeat(24)}`)).toEqual({
    base_url: `${SQUIRE_EGRESS_ORIGIN}/v1/egress/g_${'a'.repeat(24)}`,
    transport: 'egress'
  });

  for (const untrusted of [
    'http://api.beatapi.io',
    'https://attacker.invalid',
    'https://api.beatapi.io.evil.test',
    'https://api.beatapi.io:8443',
    'https://api.beatapi.io/v1',
    'https://user:pass@api.beatapi.io',
    'https://api.beatapi.io?token=leak',
    'https://api.beatapi.io#frag',
    'https://gen.pollinations.ai',
    `${SQUIRE_EGRESS_ORIGIN}/v1/egress/short`
  ]) {
    expect(() => validateProviderEndpoint('beatapi', untrusted)).toThrow();
    await expect(writeVaultEntry('beatapi', { api_key: 'sk-secret', origin: untrusted }, directory)).rejects.toThrow('Untrusted direct HTTPS origin');
  }

  expect(() => validatePinnedProviderGrant('pollinations', { base_url: 'https://evil.invalid', token: 'sk-secret' })).toThrow();
});

it('supports safe env-var overrides with strict origin pinning and precedence over vault.json', async () => {
  await writeVaultEntry('beatapi', { api_key: 'sk-file-key' }, directory);
  const env = { [vaultEnvKeyName('beatapi')]: 'sk-env-override-key' };

  expect(readVaultEnvGrant('beatapi', env)).toEqual({
    base_url: BEATAPI_ORIGIN,
    token: 'sk-env-override-key',
    source: 'env'
  });
  expect(await readVaultGrant('beatapi', directory, env)).toEqual({
    base_url: BEATAPI_ORIGIN,
    token: 'sk-env-override-key',
    source: 'env'
  });

  // Untrusted env origin fails closed instead of sending keys to an arbitrary host.
  expect(() => readVaultEnvGrant('beatapi', {
    [vaultEnvKeyName('beatapi')]: 'sk-env-override-key',
    GRUNT_VAULT_BEATAPI_ORIGIN: 'https://evil.example'
  })).toThrow('Untrusted direct HTTPS origin');

  // Allowlisted secondary origin works.
  expect(readVaultEnvGrant('aperture-ai', {
    [vaultEnvKeyName('aperture-ai')]: 'sk-aperture-key',
    GRUNT_VAULT_APERTURE_AI_ORIGIN: 'https://aperture-ai.run'
  })).toEqual({
    base_url: 'https://aperture-ai.run',
    token: 'sk-aperture-key',
    source: 'env'
  });
});

it('redacts explicit vault secrets and common credential shapes', () => {
  const raw = 'Failed calling https://user:pw@api.beatapi.io with Authorization: Bearer topsecret123 and custom-raw-secret-999 and sk-abc123456789';
  const cleaned = redactVaultSecrets(raw, ['custom-raw-secret-999']);
  expect(cleaned).not.toContain('pw');
  expect(cleaned).not.toContain('topsecret123');
  expect(cleaned).not.toContain('custom-raw-secret-999');
  expect(cleaned).not.toContain('sk-abc123456789');
  expect(cleaned).toContain('[redacted]');
});

it('supports vault CLI set/list/remove without echoing secrets or accepting keys in argv', async () => {
  const lines: string[] = [];
  const secret = 'sk-cli-imported-secret-value';

  await expect(vaultCommand(['set', 'beatapi', secret], { directory, env: {}, log: l => lines.push(l) })).rejects.toThrow('never in argv');
  await expect(vaultCommand(['set', 'beatapi', '--origin', 'https://evil.test'], {
    directory, env: {}, log: l => lines.push(l), readSecret: async () => secret
  })).rejects.toThrow('Untrusted direct HTTPS origin');

  await vaultCommand(['set', 'beatapi'], {
    directory, env: {}, log: l => lines.push(l), readSecret: async () => secret
  });
  await vaultCommand(['list', '--json'], { directory, env: {}, log: l => lines.push(l) });
  await vaultCommand(['remove', 'beatapi'], { directory, env: {}, log: l => lines.push(l) });

  const combined = lines.join('\n');
  expect(combined).not.toContain(secret);
  expect(combined).toContain('https://api.beatapi.io');
  expect(combined).toContain('removed from local Grunt vault');
});

it('dispatches BeatAPI directly over HTTPS via local vault against a fake upstream server with zero diagnostic secret leakage', async () => {
  await recordDataSharingConsent(directory, ['beatapi']);
  const secret = 'sk-beatapi-direct-secret-key-42';
  await writeVaultEntry('beatapi', { api_key: secret, source: 'import' }, directory);

  const server = await startFakeUpstream(req => {
    expect(req.authorization).toBe(`Bearer ${secret}`);
    if (req.url === '/v1/usage') {
      return { body: { data: { object: 'usage', credit_balance: 0, credits_settled: 0, lifetime_paid: 0, payment_method_present: false, auto_recharge: false } } };
    }
    if (req.url === '/v1/models') {
      return { body: { data: BEATAPI_MODELS.map(id => ({ id })) } };
    }
    if (req.url === '/v1/chat/completions') {
      return { body: { model: BEATAPI_MODEL, choices: [{ message: { content: 'direct-beatapi-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } } };
    }
    return { status: 404, body: { error: 'not found' } };
  });

  const fetcher = directBridgeFetcher(BEATAPI_ORIGIN, server.origin);
  const squire = {
    signup: vi.fn(async () => { throw new Error('Squire signup must not run when local vault key verifies'); }),
    call: vi.fn(async () => { throw new Error('Squire vault lookup must not run'); }),
    credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => { throw new Error('Squire egress grant must not run'); }) },
    approveDataSharing: vi.fn()
  };
  const notify = vi.fn();
  const diagnostics = await DiagnosticsStore.open({ directory: join(await realpath(directory), 'diagnostics'), runtimeVersion: '0.10.16' });
  const source = new BeatAPI({ directory, fetcher });

  try {
    await setupBeatAPI({ directory, squire, fetcher, notify });
    expect(squire.signup).not.toHaveBeenCalled();
    expect(squire.credentials.grant).not.toHaveBeenCalled();
    expect(JSON.stringify(notify.mock.calls)).not.toContain(secret);

    const saved = await readBeatAPIGrant(directory, {});
    expect(saved.base_url).toBe(BEATAPI_ORIGIN);
    expect(saved.version).toBe(2);

    await withDiagnosticContext({ requestId: randomUUID(), kind: 'user', attemptId: randomUUID(), sink: diagnostics }, async () => {
      const reply = await source.complete({ model: 'beatapi', cwd: directory, messages: [{ role: 'user', content: 'hi' }], tools: [], stream: false }, AbortSignal.timeout(5000));
      expect(reply.text).toBe('direct-beatapi-ok');
    });

    const events = JSON.stringify((await diagnostics.list({ includeDetails: true })).events);
    expect(events).not.toContain(secret);
    expect(events).not.toContain('trusty-squire-api.fly.dev');
    expect(server.seen.map(call => call.url)).toEqual(['/v1/usage', '/v1/models', '/v1/usage', '/v1/chat/completions', '/v1/usage']);
  } finally {
    await source.close();
    await diagnostics.close();
    await server.close();
  }
});

it('dispatches Pollinations directly over HTTPS via local vault against a fake upstream server with zero-budget guards intact', async () => {
  await recordDataSharingConsent(directory, ['pollinations']);
  const secret = 'sk-pollinations-direct-secret-key-99';
  await writeVaultEntry('pollinations', { api_key: secret, source: 'import' }, directory);

  const server = await startFakeUpstream(req => {
    expect(req.authorization).toBe(`Bearer ${secret}`);
    if (req.url === '/account/key') {
      return { body: { valid: true, type: 'secret', expiresAt: null, pollenBudget: 0, questPollenOnly: true, permissions: { models: [POLLINATIONS_MODEL], account: ['usage'] } } };
    }
    if (req.url === '/account/balance') {
      return { body: { balance: 0, accountBalance: { total: 0.5, tier: 0.5, paid: 0 } } };
    }
    if (req.url === `/v1/models/${POLLINATIONS_MODEL}`) {
      return { body: { id: POLLINATIONS_MODEL, object: 'model', owned_by: 'OSAII', category: 'text', community: true, paid_only: false, pricing: { currency: 'pollen' }, supported_endpoints: ['/v1/chat/completions'] } };
    }
    if (req.url === '/v1/chat/completions') {
      return {
        headers: { 'x-model-requested': POLLINATIONS_MODEL, 'x-model-used': POLLINATIONS_MODEL },
        body: {
          model: POLLINATIONS_RETURNED_MODEL,
          choices: [{ message: { content: JSON.stringify({ version: 1, type: 'final', text: 'direct-pollinations-ok' }), tool_calls: [] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 15, completion_tokens: 6 }
        }
      };
    }
    return { status: 404, body: { error: 'not found' } };
  });

  const fetcher = directBridgeFetcher(POLLINATIONS_ORIGIN, server.origin);
  const squire = {
    signup: vi.fn(async () => { throw new Error('Squire signup must not run'); }),
    credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => { throw new Error('Squire egress grant must not run'); }) },
    approveDataSharing: vi.fn()
  };
  const notify = vi.fn();
  const diagnostics = await DiagnosticsStore.open({ directory: join(await realpath(directory), 'diagnostics'), runtimeVersion: '0.10.16' });
  const source = new Pollinations({ directory, fetcher });

  try {
    await setupPollinations({ directory, squire, fetcher, notify });
    expect(squire.signup).not.toHaveBeenCalled();
    expect(squire.credentials.grant).not.toHaveBeenCalled();
    expect(JSON.stringify(notify.mock.calls)).not.toContain(secret);

    const saved = await readPollinationsGrant(directory, {});
    expect(saved.base_url).toBe(POLLINATIONS_ORIGIN);

    await withDiagnosticContext({ requestId: randomUUID(), kind: 'user', attemptId: randomUUID(), sink: diagnostics }, async () => {
      const reply = await source.complete({ model: 'pollinations', cwd: directory, messages: [{ role: 'user', content: 'hi' }], tools: [], stream: false }, AbortSignal.timeout(5000));
      expect(reply.text).toBe('direct-pollinations-ok');
    });

    const events = JSON.stringify((await diagnostics.list({ includeDetails: true })).events);
    expect(events).not.toContain(secret);
    expect(events).not.toContain('trusty-squire-api.fly.dev');
  } finally {
    await source.close();
    await diagnostics.close();
    await server.close();
  }
});

it('keeps backwards compatibility with existing Squire egress grants and upgrades cleanly when local vault is populated', async () => {
  const egressBeat: BeatAPIGrant = {
    version: 1,
    base_url: `${SQUIRE_EGRESS_ORIGIN}/v1/egress/g_${'b'.repeat(24)}`,
    token: 'synthetic-egress-beat-token',
    upstream_origin: BEATAPI_ORIGIN,
    model: BEATAPI_MODEL,
    verified_at: new Date().toISOString(),
    free_account_verified: true,
    lifetime_paid: 0,
    payment_method_present: false,
    auto_recharge: false,
    credit_provenance: 'zero',
    baseline_balance: 0
  };
  await writeBeatAPIGrant(egressBeat, directory);
  expect(await readBeatAPIGrant(directory, {})).toEqual(egressBeat);

  // Adding a local vault key upgrades BeatAPI to direct HTTPS while keeping the verified receipt.
  await writeVaultEntry('beatapi', { api_key: 'sk-upgraded-beat-direct' }, directory);
  expect(await readBeatAPIGrant(directory, {})).toMatchObject({
    base_url: BEATAPI_ORIGIN,
    token: 'sk-upgraded-beat-direct',
    free_account_verified: true
  });

  // Legacy Pollinations egress grant works seamlessly without a vault entry.
  const egressPoll: PollinationsGrant = {
    version: 1,
    base_url: `${SQUIRE_EGRESS_ORIGIN}/v1/egress/g_${'c'.repeat(24)}`,
    token: 'synthetic-egress-poll-token',
    upstream_origin: POLLINATIONS_ORIGIN,
    model: POLLINATIONS_MODEL,
    verified_at: new Date().toISOString(),
    free_account_verified: true,
    key_zero_budget_verified: true,
    quest_pollen_only: true
  };
  await writePollinationsGrant(egressPoll, directory);
  expect(await readPollinationsGrant(directory, {})).toEqual(egressPoll);

  // Legacy Darus egress grant works via readPrivateProviderGrant until local vault overrides it.
  const egressDarus = { base_url: `${SQUIRE_EGRESS_ORIGIN}/v1/egress/g_${'d'.repeat(24)}`, token: 'synthetic-egress-darus' };
  await writePrivateProviderGrant('darus', egressDarus, directory);
  expect(await readPrivateProviderGrant('darus', directory, {})).toEqual(egressDarus);

  await materializeDirectGrant('darus', { token: 'sk-direct-darus', source: 'local' }, directory);
  expect(await readPrivateProviderGrant('darus', directory, {})).toEqual({
    base_url: 'https://gateway.darusalfatah.id',
    token: 'sk-direct-darus'
  });

  // readFreeApiGrant also resolves local vault directly.
  await writeVaultEntry('tokenharbor', { api_key: 'sk-direct-tokenharbor' }, directory);
  expect(await readFreeApiGrant('tokenharbor', directory, {})).toEqual({
    base_url: 'https://tokenharbor.ai',
    token: 'sk-direct-tokenharbor'
  });
});

it('connects setupProviders through local Grunt vault without minting a Squire egress grant', async () => {
  const secret = 'sk-groq-local-vault-secret';
  await writeVaultEntry('groq', { api_key: secret }, directory);
  const squire = {
    credentials: { list: vi.fn(async () => []), grant: vi.fn(async () => { throw new Error('must not mint egress grant'); }) },
    runs: { start: vi.fn(async () => { throw new Error('must not start signup'); }), get: vi.fn(async () => ({ state: 'dropped' })) }
  };
  const added: { platform: string; grant: { base_url: string; token: string } }[] = [];
  const notifications: string[] = [];

  await setupProviders(squire, {
    addGrant: async (platform, grant) => { added.push({ platform, grant }); }
  }, { providers: ['groq'], notify: line => notifications.push(line), reuseSaved: false, directory });

  expect(added).toEqual([{ platform: 'groq', grant: { base_url: 'https://api.groq.com', token: secret } }]);
  expect(squire.credentials.list).not.toHaveBeenCalled();
  expect(squire.credentials.grant).not.toHaveBeenCalled();
  expect(notifications.join('\n')).toContain('connected through local Grunt vault');
  expect(notifications.join('\n')).not.toContain(secret);
});

it('materializes a direct local vault grant from Squire passkey-approved credential export and handles refusal safely', async () => {
  const squire = new BrowserSquire();
  const secret = 'sk-squire-exported-beatapi-key';
  const approvals: { approvalId: string; approvalUrl: string }[] = [];
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    expect(name).toBe('fetch_credential');
    if (args.action === 'start') {
      return {
        status: 'approval_pending',
        approval_id: 'apr_123',
        approval_url: 'https://trusty-squire.example/approve/apr_123'
      };
    }
    if (args.action === 'resume' && args.approval_id === 'apr_123') {
      return {
        status: 'credential_fetched',
        fields: { api_key: secret }
      };
    }
    return { status: 'credential_fetch_refused', reason: 'denied' };
  });

  const grant = await squire.materializeDirectVaultGrant('beatapi', 'vault://beatapi', {
    directory,
    pollIntervalMs: 50,
    onApproval: info => { approvals.push(info); }
  });
  expect(approvals).toEqual([{ approvalId: 'apr_123', approvalUrl: 'https://trusty-squire.example/approve/apr_123' }]);
  expect(grant).toEqual({ base_url: BEATAPI_ORIGIN, token: secret });
  expect(await readVaultEntry('beatapi', directory)).toMatchObject({
    api_key: secret,
    origin: BEATAPI_ORIGIN,
    source: 'squire'
  });

  vi.spyOn(squire, 'call').mockResolvedValueOnce({ status: 'credential_fetch_refused', reason: `denied ${secret}` });
  const error = await squire.materializeDirectVaultGrant('beatapi', 'vault://beatapi', { directory }).then(() => null, e => e as Error);
  expect(error?.message).toContain('Could not export beatapi key to local Grunt vault');
  expect(error?.message).not.toContain(secret);
});
