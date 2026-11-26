import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BeatAPI, BEATAPI_MODEL, BEATAPI_MODELS, BEATAPI_ORIGIN, beatapiGrantPath, readBeatAPIGrant, writeBeatAPIGrant } from './beatapi.js';
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
  pollinationsGrantPath,
  readPollinationsGrant,
  writePollinationsGrant
} from './pollinations.js';
import type { PollinationsGrant } from './pollinations.js';
import { setupPollinations } from './pollinations-setup.js';
import { materializeDirectGrant, readPrivateProviderGrant, validatePinnedProviderGrant, writePrivateProviderGrant } from './provider-grant.js';
import { Runcrate, RUNCRATE_DEEPSEEK, RuncrateVerificationError, readRuncrateGrant, writeRuncrateGrant } from './runcrate.js';
import { BrowserSquire, setup, setupProviders } from './setup.js';
import {
  SQUIRE_EGRESS_ORIGIN,
  credentialFingerprint,
  deleteVaultEntry,
  listVaultEntries,
  readVaultEntry,
  readVaultEnvGrant,
  readVaultGrant,
  redactVaultSecrets,
  validateDirectOrigin,
  validateProviderEndpoint,
  vaultEnvKeyName,
  vaultLockPath,
  vaultPath,
  withVaultLock,
  writeVaultEntry
} from './vault.js';
import { vaultCommand } from './vault-cli.js';
import { readZroGrant, writeZroGrant } from './zro.js';

const execFileAsync = promisify(execFile);

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
  expect((await stat(vaultLockPath(nested))).mode & 0o777).toBe(0o600);
  expect((await readdir(nested)).sort()).toEqual(['.vault-lock.db', 'vault.json']);

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

it('serializes concurrent vault updates across independent OS processes and recovers cleanly after SIGKILL with multiple contenders', async () => {
  const providers = ['beatapi', 'pollinations', 'darus', 'ifm', 'crowllm', 'goedel'] as const;
  const vaultModule = pathToFileURL(join(process.cwd(), 'src/local/vault.ts')).href;
  const tsxArgs = (code: string) => ['--import', 'tsx', '--input-type=module', '-e', code];
  const writerScript = `import { writeVaultEntry } from ${JSON.stringify(vaultModule)};
    await writeVaultEntry(process.env.VAULT_TEST_PROVIDER, { api_key: process.env.VAULT_TEST_KEY, source: 'import' }, process.env.VAULT_TEST_DIR);`;

  await Promise.all(providers.map(provider =>
    execFileAsync(process.execPath, tsxArgs(writerScript), {
      timeout: 15_000,
      env: { ...process.env, VAULT_TEST_PROVIDER: provider, VAULT_TEST_KEY: `sk-proc-${provider}-secret`, VAULT_TEST_DIR: directory }
    })
  ));

  expect((await readdir(directory)).sort()).toEqual(['.vault-lock.db', 'vault.json']);
  expect((await stat(vaultPath(directory))).mode & 0o777).toBe(0o600);
  expect((await stat(vaultLockPath(directory))).mode & 0o777).toBe(0o600);
  for (const provider of providers) {
    expect(await readVaultEntry(provider, directory)).toMatchObject({ api_key: `sk-proc-${provider}-secret` });
  }

  // Multi-contender recovery after SIGKILL of a process holding the OS lock:
  // none of the contenders can steal or unlink the lock while the owner is alive,
  // and once the owner is SIGKILLed all contenders serialize with zero lost updates.
  const recoveryDir = await mkdtemp(join(tmpdir(), 'grunt-vault-sigkill-'));
  const holderScript = `import { withVaultLock } from ${JSON.stringify(vaultModule)};
    process.stdin.resume();
    await withVaultLock(process.env.VAULT_TEST_DIR, async () => {
      process.stdout.write('locked\\n');
      await new Promise(() => {});
    });`;

  try {
    await writeVaultEntry('kilo', { api_key: 'sk-seed-kilo', source: 'local' }, recoveryDir);
    const holder = spawn(process.execPath, tsxArgs(holderScript), {
      env: { ...process.env, VAULT_TEST_DIR: recoveryDir },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let holderOut = '';
    holder.stdout.on('data', chunk => { holderOut += String(chunk); });
    const holderExited = once(holder, 'exit');
    let contenders: Promise<unknown>[] = [];

    try {
      await vi.waitFor(() => expect(holderOut).toContain('locked'), { timeout: 10_000 });
      contenders = providers.map(provider =>
        execFileAsync(process.execPath, tsxArgs(writerScript), {
          timeout: 15_000,
          env: { ...process.env, VAULT_TEST_PROVIDER: provider, VAULT_TEST_KEY: `sk-recovered-${provider}`, VAULT_TEST_DIR: recoveryDir }
        })
      );

      // While holder is alive, contenders must remain blocked without mutating vault.json.
      await delay(250);
      expect((await listVaultEntries(recoveryDir, {})).map(item => item.provider)).toEqual(['kilo']);

      holder.kill('SIGKILL');
      await holderExited;
      await Promise.all(contenders);
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
      await holderExited;
      await Promise.allSettled(contenders);
    }

    expect((await readdir(recoveryDir)).sort()).toEqual(['.vault-lock.db', 'vault.json']);
    expect(await readVaultEntry('kilo', recoveryDir)).toMatchObject({ api_key: 'sk-seed-kilo' });
    for (const provider of providers) {
      expect(await readVaultEntry(provider, recoveryDir)).toMatchObject({ api_key: `sk-recovered-${provider}` });
    }
  } finally {
    await rm(recoveryDir, { recursive: true, force: true });
  }
}, 25_000);

it('never evicts a live vault lock owner while contenders wait or time out', async () => {
  const vaultModule = pathToFileURL(join(process.cwd(), 'src/local/vault.ts')).href;
  const tsxArgs = (code: string) => ['--import', 'tsx', '--input-type=module', '-e', code];
  const contendersList = ['beatapi', 'pollinations', 'darus', 'ifm'] as const;
  const liveHolderScript = `import { readFile, rename, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { withVaultLock, vaultPath } from ${JSON.stringify(vaultModule)};
    const dir = process.env.VAULT_TEST_DIR;
    await withVaultLock(dir, async () => {
      const store = JSON.parse(await readFile(vaultPath(dir), 'utf8'));
      process.stdout.write('locked\\n');
      for await (const _chunk of process.stdin) { /* wait until parent releases */ }
      store.providers.zro = {
        api_key: 'sk-live-holder-zro',
        origin: 'https://zro.moonmath.ai',
        source: 'local',
        updated_at: new Date().toISOString()
      };
      const tmp = join(dir, '.vault-holder.tmp');
      await writeFile(tmp, JSON.stringify(store, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(tmp, vaultPath(dir));
    });`;
  const writerScript = `import { writeVaultEntry } from ${JSON.stringify(vaultModule)};
    await writeVaultEntry(process.env.VAULT_TEST_PROVIDER, { api_key: process.env.VAULT_TEST_KEY, source: 'import' }, process.env.VAULT_TEST_DIR);`;

  await writeVaultEntry('kilo', { api_key: 'sk-seed-live', source: 'local' }, directory);
  const holder = spawn(process.execPath, tsxArgs(liveHolderScript), {
    env: { ...process.env, VAULT_TEST_DIR: directory },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let holderOut = '';
  holder.stdout.on('data', chunk => { holderOut += String(chunk); });
  const holderExited = once(holder, 'exit');
  let contenders: Promise<unknown>[] = [];

  try {
    await vi.waitFor(() => expect(holderOut).toContain('locked'), { timeout: 10_000 });
    contenders = contendersList.map(provider =>
      execFileAsync(process.execPath, tsxArgs(writerScript), {
        timeout: 15_000,
        env: { ...process.env, VAULT_TEST_PROVIDER: provider, VAULT_TEST_KEY: `sk-after-live-${provider}`, VAULT_TEST_DIR: directory }
      })
    );

    // A short-timeout contender must fail cleanly without evicting the live holder.
    await expect(withVaultLock(directory, async () => 'stolen', { timeoutMs: 250 })).rejects.toThrow('Timed out waiting for local Grunt vault lock');
    expect((await listVaultEntries(directory, {})).map(item => item.provider)).toEqual(['kilo']);

    // Release the live holder so it commits its own write, then all waiting contenders serialize after it.
    holder.stdin.end();
    const [holderCode] = await holderExited;
    expect(holderCode).toBe(0);
    await Promise.all(contenders);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    await holderExited;
    await Promise.allSettled(contenders);
  }

  expect(await readVaultEntry('kilo', directory)).toMatchObject({ api_key: 'sk-seed-live' });
  expect(await readVaultEntry('zro', directory)).toMatchObject({ api_key: 'sk-live-holder-zro' });
  for (const provider of contendersList) {
    expect(await readVaultEntry(provider, directory)).toMatchObject({ api_key: `sk-after-live-${provider}` });
  }
}, 25_000);

it('rejects insecure vault permissions, symlinks, broad directories, FIFOs, and unsafe lockfiles', async () => {
  await writeVaultEntry('beatapi', { api_key: 'sk-beatapi-secret' }, directory);

  await chmod(vaultPath(directory), 0o644);
  await expect(readVaultGrant('beatapi', directory, {})).rejects.toThrow('Unsafe local vault file');

  await chmod(vaultPath(directory), 0o600);
  await chmod(directory, 0o755);
  await expect(readVaultGrant('beatapi', directory, {})).rejects.toThrow('Unsafe local vault directory');
  await chmod(directory, 0o700);

  // Unsafe lockfile permissions, symlinks, and FIFOs fail closed without touching targets.
  await chmod(vaultLockPath(directory), 0o644);
  await expect(writeVaultEntry('beatapi', { api_key: 'sk-beatapi-secret-2' }, directory)).rejects.toThrow('Unsafe local vault lockfile');
  await rm(vaultLockPath(directory));

  const lockTarget = join(directory, 'protected-lock-target');
  await writeFile(lockTarget, 'preserved', { mode: 0o600 });
  await symlink(lockTarget, vaultLockPath(directory));
  await expect(writeVaultEntry('beatapi', { api_key: 'sk-beatapi-secret-2' }, directory)).rejects.toThrow('Unsafe local vault lockfile');
  expect(await readFile(lockTarget, 'utf8')).toBe('preserved');
  await rm(vaultLockPath(directory));

  if (process.platform !== 'win32') {
    execFileSync('mkfifo', ['-m', '600', vaultLockPath(directory)]);
    await expect(writeVaultEntry('beatapi', { api_key: 'sk-beatapi-secret-2' }, directory)).rejects.toThrow('Unsafe local vault lockfile');
    await rm(vaultLockPath(directory));
  }

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

it('dispatches BeatAPI directly via local vault without copying raw keys into beatapi.json, and revokes on vault remove or key swap', async () => {
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

    // Receipt on disk stores metadata + fingerprint only, never the raw API key.
    const rawReceiptText = await readFile(beatapiGrantPath(directory), 'utf8');
    expect(rawReceiptText).not.toContain(secret);
    const rawReceipt = JSON.parse(rawReceiptText) as Record<string, unknown>;
    expect(rawReceipt).not.toHaveProperty('token');
    expect(rawReceipt.credential_source).toBe('vault');
    expect(rawReceipt.credential_sha256).toBe(credentialFingerprint({ base_url: BEATAPI_ORIGIN, token: secret }));

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

    // Removing the key from the vault immediately revokes BeatAPI access (no fallback key in receipt).
    await vaultCommand(['remove', 'beatapi'], { directory, env: {}, log: () => {} });
    await expect(readBeatAPIGrant(directory, {})).rejects.toMatchObject({ code: 'logged_out' });
    expect(await source.available()).toBe(false);

    // Replacing with a different unverified key also fails closed until setup re-verifies.
    await writeVaultEntry('beatapi', { api_key: 'sk-beatapi-replacement-unverified', source: 'import' }, directory);
    await expect(readBeatAPIGrant(directory, {})).rejects.toMatchObject({ code: 'logged_out' });
    expect(await source.available()).toBe(false);
    expect(server.seen).toHaveLength(5);
  } finally {
    await source.close();
    await diagnostics.close();
    await server.close();
  }
});

it('dispatches Pollinations directly via local vault without copying raw keys into pollinations.json, and revokes on vault remove or key swap', async () => {
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

    // Receipt on disk stores metadata + fingerprint only, never the raw API key.
    const rawReceiptText = await readFile(pollinationsGrantPath(directory), 'utf8');
    expect(rawReceiptText).not.toContain(secret);
    const rawReceipt = JSON.parse(rawReceiptText) as Record<string, unknown>;
    expect(rawReceipt).not.toHaveProperty('token');
    expect(rawReceipt.credential_source).toBe('vault');
    expect(rawReceipt.credential_sha256).toBe(credentialFingerprint({ base_url: POLLINATIONS_ORIGIN, token: secret }));

    const saved = await readPollinationsGrant(directory, {});
    expect(saved.base_url).toBe(POLLINATIONS_ORIGIN);

    await withDiagnosticContext({ requestId: randomUUID(), kind: 'user', attemptId: randomUUID(), sink: diagnostics }, async () => {
      const reply = await source.complete({ model: 'pollinations', cwd: directory, messages: [{ role: 'user', content: 'hi' }], tools: [], stream: false }, AbortSignal.timeout(5000));
      expect(reply.text).toBe('direct-pollinations-ok');
    });

    const events = JSON.stringify((await diagnostics.list({ includeDetails: true })).events);
    expect(events).not.toContain(secret);
    expect(events).not.toContain('trusty-squire-api.fly.dev');

    const countBeforeRevoke = server.seen.length;
    await vaultCommand(['remove', 'pollinations'], { directory, env: {}, log: () => {} });
    await expect(readPollinationsGrant(directory, {})).rejects.toMatchObject({ code: 'logged_out' });
    expect(await source.available()).toBe(false);

    await writeVaultEntry('pollinations', { api_key: 'sk-pollinations-replacement-unverified', source: 'import' }, directory);
    await expect(readPollinationsGrant(directory, {})).rejects.toMatchObject({ code: 'logged_out' });
    expect(await source.available()).toBe(false);
    expect(server.seen).toHaveLength(countBeforeRevoke);
  } finally {
    await source.close();
    await diagnostics.close();
    await server.close();
  }
});

it('binds Runcrate key_topups_disabled and Zro receipts to the verified credential fingerprint and invalidates on key replacement', async () => {
  await recordDataSharingConsent(directory, ['runcrate']);
  const verifiedKey = 'sk-runcrate-verified-key-1';
  const replacementKey = 'sk-runcrate-replacement-key-2';
  const verifiedGrant = { base_url: 'https://api.runcrate.ai', token: verifiedKey };
  await writeVaultEntry('runcrate', { api_key: verifiedKey, source: 'import' }, directory);
  await expect(writeRuncrateGrant(verifiedGrant, directory)).rejects.toBeInstanceOf(RuncrateVerificationError);
  await writeRuncrateGrant(verifiedGrant, directory, {
    verification: {
      free_account_verified: true,
      key_topups_disabled: true,
      credential_sha256: credentialFingerprint(verifiedGrant),
      verified_at: new Date().toISOString()
    }
  });

  // Direct receipt stores fingerprint only, never the raw key.
  const rawText = await readFile(join(directory, 'runcrate.json'), 'utf8');
  expect(rawText).not.toContain(verifiedKey);
  expect(JSON.parse(rawText)).toMatchObject({
    credential_source: 'vault',
    credential_sha256: credentialFingerprint(verifiedGrant),
    key_topups_disabled: true
  });

  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: RUNCRATE_DEEPSEEK }] }));
  const source = new Runcrate({ directory, fetcher });
  expect(await source.available()).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce();
  fetcher.mockClear();

  // Replacing the key in vault.json invalidates the old key_topups_disabled receipt.
  await writeVaultEntry('runcrate', { api_key: replacementKey, source: 'import' }, directory);
  await expect(readRuncrateGrant(directory, {})).rejects.toThrow('does not match');
  expect(await source.available()).toBe(false);
  await expect(source.complete({ model: 'runcrate', cwd: directory, messages: [{ role: 'user', content: 'hi' }], tools: [], stream: false }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'logged_out' });
  expect(fetcher).not.toHaveBeenCalled();

  // Replacing via env var also invalidates the old receipt.
  await writeVaultEntry('runcrate', { api_key: verifiedKey, source: 'import' }, directory);
  expect(await readRuncrateGrant(directory, {})).toMatchObject({ token: verifiedKey, key_topups_disabled: true });
  await expect(readRuncrateGrant(directory, { [vaultEnvKeyName('runcrate')]: replacementKey })).rejects.toThrow('does not match');

  // Removing from vault also revokes the vault-backed receipt immediately.
  await deleteVaultEntry('runcrate', directory);
  await expect(readRuncrateGrant(directory, {})).rejects.toThrow('Invalid runcrate vault-backed verification receipt');

  // Legacy egress Runcrate receipt also refuses an unverified replacement vault key.
  const legacyEgress = { base_url: `${SQUIRE_EGRESS_ORIGIN}/v1/egress/g_${'r'.repeat(24)}`, token: 'synthetic-egress-runcrate' };
  await rm(join(directory, 'runcrate.json'), { force: true });
  await writeRuncrateGrant(legacyEgress, directory);
  expect(await readRuncrateGrant(directory, {})).toMatchObject({ ...legacyEgress, key_topups_disabled: true });
  await writeVaultEntry('runcrate', { api_key: replacementKey, source: 'import' }, directory);
  await expect(readRuncrateGrant(directory, {})).rejects.toThrow('does not match');
  await source.close();

  // Zro receipts are likewise bound to the verified credential fingerprint.
  const zroKey = 'sk-zro-verified-1';
  await writeVaultEntry('zro', { api_key: zroKey, source: 'import' }, directory);
  await writeZroGrant({ base_url: 'https://zro.moonmath.ai', token: zroKey }, directory);
  expect(await readFile(join(directory, 'zro.json'), 'utf8')).not.toContain(zroKey);
  expect(await readZroGrant(directory, {})).toMatchObject({ base_url: 'https://zro.moonmath.ai', token: zroKey });
  await writeVaultEntry('zro', { api_key: 'sk-zro-unverified-2', source: 'import' }, directory);
  await expect(readZroGrant(directory, {})).rejects.toThrow('verification is missing');
});

it('requires fresh exact-key free-account and top-up verification during Runcrate setup for replacement vault and env keys', async () => {
  await recordDataSharingConsent(directory, ['runcrate']);
  const verifiedKey = 'sk-runcrate-initial-verified-key';
  const replacementKey = 'sk-runcrate-replacement-vault-key';
  const envReplacementKey = 'sk-runcrate-replacement-env-key';
  const verifiedGrant = { base_url: 'https://api.runcrate.ai', token: verifiedKey };
  const replacementGrant = { base_url: 'https://api.runcrate.ai', token: replacementKey };
  const envReplacementGrant = { base_url: 'https://api.runcrate.ai', token: envReplacementKey };

  await writeVaultEntry('runcrate', { api_key: verifiedKey, source: 'import' }, directory);
  const initialProof = {
    free_account_verified: true as const,
    key_topups_disabled: true as const,
    credential_sha256: credentialFingerprint(verifiedGrant),
    verified_at: new Date().toISOString()
  };
  await writeRuncrateGrant(verifiedGrant, directory, { verification: initialProof });

  const server = await startFakeUpstream(req => {
    if (req.url === '/v1/models') {
      return { body: { data: [{ id: RUNCRATE_DEEPSEEK }] } };
    }
    if (req.url === '/v1/chat/completions') {
      return { body: { model: RUNCRATE_DEEPSEEK, choices: [{ message: { content: 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } } };
    }
    return { status: 404, body: { error: 'not found' } };
  });

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const requested = String(input);
    const parsed = new URL(requested);
    expect(parsed.origin).toBe('https://api.runcrate.ai');
    return realFetch(`${server.origin}${parsed.pathname}${parsed.search}`, init);
  });

  const squire = {
    credentials: {
      list: vi.fn(async () => { throw new Error('Squire list must not bypass replacement verification'); }),
      grant: vi.fn(async () => { throw new Error('Squire grant must not bypass replacement verification'); })
    },
    runs: {
      start: vi.fn(async () => { throw new Error('Squire signup must not bypass replacement verification'); }),
      get: vi.fn()
    }
  };

  try {
    // Replace key in vault.json without fresh verification: setup must refuse and preserve old receipt.
    await writeVaultEntry('runcrate', { api_key: replacementKey, source: 'import' }, directory);
    const notifications: string[] = [];
    await expect(setup(line => notifications.push(line), ['runcrate'], { directory, squire }))
      .rejects.toBeInstanceOf(RuncrateVerificationError);
    expect(server.seen).toHaveLength(0);
    expect(squire.credentials.list).not.toHaveBeenCalled();
    expect(squire.runs.start).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(directory, 'runcrate.json'), 'utf8'))).toMatchObject({
      credential_sha256: credentialFingerprint(verifiedGrant)
    });
    expect(await new Runcrate({ directory }).available()).toBe(false);

    // Stale proof bound to the old key or key_topups_disabled=false must also be rejected before probing.
    await expect(setup(line => notifications.push(line), ['runcrate'], {
      directory,
      squire,
      verifyRuncrateGrant: async () => initialProof
    })).rejects.toBeInstanceOf(RuncrateVerificationError);
    await expect(setup(line => notifications.push(line), ['runcrate'], {
      directory,
      squire,
      verifyRuncrateGrant: async grant => ({
        free_account_verified: true,
        key_topups_disabled: false as unknown as true,
        credential_sha256: credentialFingerprint(grant),
        verified_at: new Date().toISOString()
      })
    })).rejects.toBeInstanceOf(RuncrateVerificationError);
    await expect(setup(line => notifications.push(line), ['runcrate'], {
      directory,
      squire,
      verifyRuncrateGrant: async () => { throw new Error('Auto top-ups are enabled on this key'); }
    })).rejects.toBeInstanceOf(RuncrateVerificationError);
    expect(server.seen).toHaveLength(0);
    expect(JSON.parse(await readFile(join(directory, 'runcrate.json'), 'utf8'))).toMatchObject({
      credential_sha256: credentialFingerprint(verifiedGrant)
    });

    // Fresh free-account + top-ups-disabled verification for the exact replacement key succeeds.
    const verifiedCalls: string[] = [];
    await setup(line => notifications.push(line), ['runcrate'], {
      directory,
      squire,
      verifyRuncrateGrant: async grant => {
        verifiedCalls.push(grant.token);
        return {
          free_account_verified: true,
          key_topups_disabled: true,
          credential_sha256: credentialFingerprint(grant),
          verified_at: new Date().toISOString()
        };
      }
    });
    expect(verifiedCalls).toEqual([replacementKey]);
    expect(server.seen).toEqual([{ method: 'POST', url: '/v1/chat/completions', authorization: `Bearer ${replacementKey}` }]);
    expect(notifications.join('\n')).not.toContain(replacementKey);
    const updatedReceipt = await readFile(join(directory, 'runcrate.json'), 'utf8');
    expect(updatedReceipt).not.toContain(replacementKey);
    expect(JSON.parse(updatedReceipt)).toMatchObject({
      credential_source: 'vault',
      credential_sha256: credentialFingerprint(replacementGrant),
      free_account_verified: true,
      key_topups_disabled: true
    });
    expect(await readRuncrateGrant(directory, {})).toMatchObject({ ...replacementGrant, key_topups_disabled: true });
    expect(await new Runcrate({ directory }).available()).toBe(true);

    // Env-var replacement key also requires fresh verification for that exact env key.
    vi.stubEnv(vaultEnvKeyName('runcrate'), envReplacementKey);
    await expect(setup(() => {}, ['runcrate'], { directory, squire })).rejects.toBeInstanceOf(RuncrateVerificationError);
    await setup(() => {}, ['runcrate'], {
      directory,
      squire,
      verifyRuncrateGrant: async grant => ({
        free_account_verified: true,
        key_topups_disabled: true,
        credential_sha256: credentialFingerprint(grant),
        verified_at: new Date().toISOString()
      })
    });
    expect(await readRuncrateGrant(directory)).toMatchObject({ ...envReplacementGrant, key_topups_disabled: true });
  } finally {
    await server.close();
  }
});

it('keeps backwards compatibility with existing Squire egress grants and rejects tampered raw-key direct receipts', async () => {
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

  // Tampered beatapi.json embedding a raw direct token without vault source is rejected.
  await writeFile(beatapiGrantPath(directory), JSON.stringify({ ...egressBeat, base_url: BEATAPI_ORIGIN, token: 'sk-raw-in-receipt' }), { mode: 0o600 });
  await expect(readBeatAPIGrant(directory, {})).rejects.toMatchObject({ code: 'logged_out' });

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

it('wires passkey-approved export into production setupProviders and falls back to Squire egress when declined or unavailable', async () => {
  const squire = new BrowserSquire();
  const secret = 'sk-groq-passkey-exported-secret';
  const callSpy = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'list_credentials') return { credentials: [{ service: 'groq', reference: 'vault://groq', field_names: ['api_key'] }] };
    if (name === 'fetch_credential' && args.action === 'start') {
      return { status: 'approval_pending', approval_id: 'apr_groq', approval_url: 'https://trusty-squire.example/approve/apr_groq' };
    }
    if (name === 'fetch_credential' && args.action === 'resume') {
      return { status: 'credential_fetched', fields: { api_key: secret } };
    }
    if (name === 'grant_app_access') throw new Error('must not mint egress grant when passkey export succeeds');
    return {};
  });
  vi.spyOn(squire, 'materializeDirectVaultGrant').mockImplementationOnce((provider, reference, opts) =>
    BrowserSquire.prototype.materializeDirectVaultGrant.call(squire, provider, reference, { ...opts, pollIntervalMs: 50 })
  );

  const added: { platform: string; grant: { base_url: string; token: string } }[] = [];
  const notifications: string[] = [];
  await setupProviders(squire, {
    addGrant: async (platform, grant) => { added.push({ platform, grant }); }
  }, { providers: ['groq'], notify: line => notifications.push(line), reuseSaved: false, directory });

  expect(added).toEqual([{ platform: 'groq', grant: { base_url: 'https://api.groq.com', token: secret } }]);
  expect(await readVaultEntry('groq', directory)).toMatchObject({ api_key: secret, origin: 'https://api.groq.com', source: 'squire' });
  expect(callSpy.mock.calls.some(([name]) => name === 'grant_app_access')).toBe(false);
  expect(notifications.join('\n')).toContain('confirm Squire passkey export');
  expect(notifications.join('\n')).toContain('connected through local Grunt vault');
  expect(notifications.join('\n')).not.toContain(secret);

  // When passkey export is declined, setupProviders cleanly falls back to Squire egress.
  await deleteVaultEntry('groq', directory);
  added.length = 0;
  notifications.length = 0;
  callSpy.mockImplementation(async name => {
    if (name === 'list_credentials') return { credentials: [{ service: 'groq', reference: 'vault://groq', field_names: ['api_key'] }] };
    if (name === 'fetch_credential') return { status: 'credential_fetch_refused', reason: 'user_denied' };
    if (name === 'grant_app_access') return { base_url: `${SQUIRE_EGRESS_ORIGIN}/v1/egress/g_${'e'.repeat(24)}`, token: 'synthetic-egress-fallback' };
    return {};
  });
  await setupProviders(squire, {
    addGrant: async (platform, grant) => { added.push({ platform, grant }); }
  }, { providers: ['groq'], notify: line => notifications.push(line), reuseSaved: false, directory });

  expect(added).toEqual([{ platform: 'groq', grant: { base_url: `${SQUIRE_EGRESS_ORIGIN}/v1/egress/g_${'e'.repeat(24)}`, token: 'synthetic-egress-fallback' } }]);
  expect(notifications.join('\n')).toContain('connected through Squire grant');
  expect(notifications.join('\n')).not.toContain('synthetic-egress-fallback');
});

it('wires passkey-approved export into setupBeatAPI and setupPollinations after browser signup, with immediate egress fallback in background mode', async () => {
  await recordDataSharingConsent(directory, ['beatapi', 'pollinations']);
  const beatSecret = 'sk-beat-exported-via-signup';
  const pollSecret = 'sk-poll-exported-via-signup';
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'signup').mockResolvedValue();
  const callSpy = vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name === 'list_credentials') {
      return {
        credentials: [
          { service: 'beatapi', label: 'grunt', reference: 'vault://beatapi-new', field_names: ['value'], allowed_hosts: ['api.beatapi.io'] },
          { service: 'pollinations', label: 'grunt-free-pollinations', reference: 'vault://poll-new', field_names: ['api_key'], allowed_hosts: ['gen.pollinations.ai'] }
        ]
      };
    }
    if (name === 'fetch_credential' && args.action === 'start') {
      const secret = args.reference === 'vault://beatapi-new' ? beatSecret : pollSecret;
      return { status: 'credential_fetched', fields: { api_key: secret } };
    }
    if (name === 'grant_app_access') throw new Error('must not call grant_app_access when export succeeds');
    return {};
  });

  const beatFetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url).startsWith(BEATAPI_ORIGIN)).toBe(true);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${beatSecret}`);
    return String(url).endsWith('/v1/models')
      ? Response.json({ data: BEATAPI_MODELS.map(id => ({ id })) })
      : Response.json({ data: { object: 'usage', credit_balance: 0, credits_settled: 0 } });
  });
  await setupBeatAPI({ directory, squire, fetcher: beatFetcher });
  expect(await readVaultEntry('beatapi', directory)).toMatchObject({ api_key: beatSecret, origin: BEATAPI_ORIGIN, source: 'squire' });
  expect(await readFile(beatapiGrantPath(directory), 'utf8')).not.toContain(beatSecret);
  expect(await readBeatAPIGrant(directory, {})).toMatchObject({ base_url: BEATAPI_ORIGIN, token: beatSecret, version: 2 });

  const pollFetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url).startsWith(POLLINATIONS_ORIGIN)).toBe(true);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${pollSecret}`);
    const route = String(url).slice(POLLINATIONS_ORIGIN.length);
    if (route === '/account/key') return Response.json({ valid: true, type: 'secret', expiresAt: null, pollenBudget: 0, questPollenOnly: true, permissions: { models: null, account: ['usage'] } });
    if (route === '/account/balance') return Response.json({ balance: 0, accountBalance: { total: 0.25, tier: 0.25, paid: 0 } });
    return Response.json({ id: POLLINATIONS_MODEL, object: 'model', owned_by: 'OSAII', category: 'text', community: true, paid_only: false, pricing: { currency: 'pollen' }, supported_endpoints: ['/v1/chat/completions'] });
  });
  await setupPollinations({ directory, squire, fetcher: pollFetcher });
  expect(await readVaultEntry('pollinations', directory)).toMatchObject({ api_key: pollSecret, origin: POLLINATIONS_ORIGIN, source: 'squire' });
  expect(await readFile(pollinationsGrantPath(directory), 'utf8')).not.toContain(pollSecret);
  expect(await readPollinationsGrant(directory, {})).toMatchObject({ base_url: POLLINATIONS_ORIGIN, token: pollSecret });

  // In background mode, approval_pending falls back immediately to Squire egress without polling.
  await deleteVaultEntry('beatapi', directory);
  await rm(beatapiGrantPath(directory), { force: true });
  const egressUrl = `${SQUIRE_EGRESS_ORIGIN}/v1/egress/g_${'f'.repeat(24)}`;
  callSpy.mockImplementation(async name => {
    if (name === 'list_credentials') {
      return { credentials: [{ service: 'beatapi', label: 'grunt', reference: 'vault://beatapi-bg', field_names: ['value'], allowed_hosts: ['api.beatapi.io'] }] };
    }
    if (name === 'fetch_credential') {
      return { status: 'approval_pending', approval_id: 'apr_bg', approval_url: 'https://trusty-squire.example/approve/apr_bg' };
    }
    if (name === 'grant_app_access') return { base_url: egressUrl, token: 'synthetic-bg-egress-token' };
    return {};
  });
  const bgFetcher = vi.fn<typeof fetch>(async url => {
    expect(String(url).startsWith(egressUrl)).toBe(true);
    return String(url).endsWith('/v1/models')
      ? Response.json({ data: BEATAPI_MODELS.map(id => ({ id })) })
      : Response.json({ data: { object: 'usage', credit_balance: 0, credits_settled: 0 } });
  });
  await setupBeatAPI({ directory, squire, fetcher: bgFetcher, background: true });
  expect(await readBeatAPIGrant(directory, {})).toMatchObject({ base_url: egressUrl, token: 'synthetic-bg-egress-token' });
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
