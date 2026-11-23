import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SetupTable } from './setup-table.js';
import { BrowserSquire, setupProviders } from './setup.js';
import { setupFallbacks } from './fallback-setup.js';
import { recordDataSharingConsent } from './data-sharing.js';

let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
});

it('prints Squire\'s own stop reason for a dropped signup in debug mode', async () => {
  vi.stubEnv('GRUNT_SETUP_DEBUG', '1');
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'failed', session_id: 'zro-tab', reason: 'Google sign-in page did not load', remaining: 'open the account page' }
    : {});
  const debug = vi.spyOn(console, 'error').mockImplementation(() => {});
  const setupProvider = vi.fn(async () => { await squire.signup('zro', 'https://zro.moonmath.ai/sign-up', 'Verify free access'); });
  await expect(setupFallbacks({ directory, squire, adapters: ['zro'], signal: new AbortController().signal,
    notify: () => {}, connect: async () => {}, run: async () => {}, setupProvider })).resolves.toEqual({ unavailable: ['zro'] });
  const lines = debug.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('grunt setup: zro:'));
  expect(lines).toEqual(['grunt setup: zro: browser could not continue; Squire\'s reason: Google sign-in page did not load (squire status: failed; reason: Google sign-in page did not load; remaining: open the account page;)']);
});

it('reports Squire\'s own reason without the debug line when debug mode is off', async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'failed', session_id: 'zro-tab', reason: 'blocked' } : {});
  const debug = vi.spyOn(console, 'error').mockImplementation(() => {});
  const setupProvider = async () => { await squire.signup('zro', 'https://zro.moonmath.ai/sign-up', 'Verify free access'); };
  await setupFallbacks({ directory, squire, adapters: ['zro'], signal: new AbortController().signal,
    notify: () => {}, connect: async () => {}, run: async () => {}, setupProvider });
  expect(squire.signupFailure('zro')).toBe('browser could not continue; Squire\'s reason: blocked');
  expect(debug.mock.calls.some(call => String(call[0]).startsWith('grunt setup:'))).toBe(false);
});

it('carries the provider page\'s own refusal words into the setup result', async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  await recordDataSharingConsent(directory, ['fikra']);
  const page = '{"detail": "This network has been blocked for automated signup abuse.", "code": "source_blocked"}';
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'stuck', session_id: 'fikra-tab', observation: { url: 'https://fikraapi.co.ke/account/signup', dom: page, safe_table: [] } }
    : {});
  const settled: (string | undefined)[] = [];
  const setupProvider = async () => { await squire.signup('fikra', 'https://fikraapi.co.ke/account/signup', 'Capture one key'); };
  await setupFallbacks({ directory, squire, adapters: ['fikra'], signal: new AbortController().signal,
    notify: () => {}, connect: async () => {}, run: async () => {}, setupProvider, onSettled: (_id, _ok, reason) => { settled.push(reason); } });
  expect(settled).toEqual(['browser could not continue; the page says: This network has been blocked for automated signup abuse.']);
});

it('does not quote page text while the page still offers controls', async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'stuck', session_id: 'zro-tab', observation: { dom: 'Welcome back, person@example.com', safe_table: [['@e1', 'b', 'Continue']] } }
    : {});
  const setupProvider = async () => { await squire.signup('zro', 'https://zro.moonmath.ai/sign-up', 'Verify free access'); };
  await setupFallbacks({ directory, squire, adapters: ['zro'], signal: new AbortController().signal,
    notify: () => {}, connect: async () => {}, run: async () => {}, setupProvider });
  expect(squire.signupFailure('zro')).toBe('browser could not continue');
});

it('names the real Runcrate failure instead of a fixed GitHub-age message', async () => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  const lines: string[] = [];
  const setupProvider = async () => { throw new Error('Squire operate_drive is unavailable; resume setup after reconnecting Squire'); };
  await setupFallbacks({ directory, squire, adapters: ['runcrate'], dataSharingApproved: ['runcrate'], signal: new AbortController().signal,
    notify: line => lines.push(line), connect: async () => {}, run: async () => {}, setupProvider });
  expect(lines).toContain('Runcrate free setup incomplete (Squire unavailable); rerun usegrunt setup to resume. Other routes remain available.');
  expect(lines.join('\n')).not.toContain('30 days');
});

it.each([undefined, { safe_table: [['@e1', 'b', 'Continue']] }])('passes a Squire refusal without requiring an empty DOM', async observation => {
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'rejected', reason: 'Provider denied automated signup.', session_id: 'refused', observation } : {});
  await expect(squire.signup('runcrate', 'https://runcrate.test', 'Capture access')).rejects.toThrow('Provider denied automated signup.');
  expect(squire.signupFailure('runcrate')).toContain('Provider denied automated signup.');
  await squire.close();
});

it('redacts unsafe Squire refusal reasons before exposing them', async () => {
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'rejected', reason: 'secret is synthetic-sensitive-value', session_id: 'refused' } : {});
  await expect(squire.signup('runcrate', 'https://runcrate.test', 'Capture access')).rejects.toThrow('provider refused');
  expect(squire.signupFailure('runcrate')).not.toContain('synthetic-sensitive-value');
  await squire.close();
});

const stopQuestion = 'Choose one current target key, or DONE, BLOCKED, NONE_OF_THESE, or WAIT.';
const stopReason = 'model confidence is below the drive threshold on https://zro.test/api-keys';

it.each([false, true].flatMap(polled => [
  { reason: stopReason, expected: 'model confidence is below the drive threshold on [link omitted]' },
  { reason: 'No matching fact for the API key name field', expected: 'No matching fact for the API key name field' },
  { reason: 'Provider denied automated signup. Password "SyntheticPass!42" was rejected', expected: 'Provider denied automated signup.' },
  { reason: 'Provider denied automated signup. Password Swordfish was rejected', expected: 'Provider denied automated signup.' },
  { reason: 'Provider denied automated signup. Password is correct horse battery staple', expected: 'Provider denied automated signup.' },
  { reason: 'API key aBcD was rejected', expected: 'API key [redacted] was rejected' },
  { reason: 'API key 123e4567-e89b-12d3-a456-426614174000 was rejected; "api_key": "quoted-value"', expected: 'API key [redacted] was rejected; "api_key": [redacted]' }
].map(diagnostic => ({ polled, ...diagnostic }))))('notifies full Squire diagnostics for a provisioning drop ($polled, $reason)', async ({ polled, reason, expected }) => {
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'low_confidence', question: `${stopQuestion} ghp_syntheticSensitive1234567890`, confidence: 0.32, reason: `${reason} Basic short-value`, session_id: 'tab' } : {});
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([]);
  if (polled) vi.spyOn(squire.runs, 'start').mockResolvedValueOnce({ run: { id: 'zro', state: 'running' }, decision: 'silent' });
  const lines: string[] = [];
  await setupProviders(squire, { addGrant: async () => {} }, { providers: ['zro'], reuseSaved: false, notify: line => lines.push(line) });
  expect(lines.join('\n')).toContain(stopQuestion);
  expect(lines.join('\n')).toContain('confidence 0.32');
  expect(lines.join('\n')).not.toContain('ghp_syntheticSensitive1234567890');
  expect(lines.join('\n')).not.toContain('short-value');
  expect(lines.join('\n')).not.toContain('123e4567-e89b-12d3-a456-426614174000');
  expect(lines.join('\n')).not.toContain('quoted-value');
  expect(lines.join('\n')).not.toContain('SyntheticPass!42');
  for (const secret of ['Password', 'Swordfish', 'correct', 'horse', 'battery', 'staple', 'aBcD']) expect(lines.join('\n')).not.toContain(secret);
  expect(lines.join('\n')).toContain(expected);
  await squire.close();
});

it.each([40, 80, undefined])('renders fallback diagnostics in full at %s columns, redacting secrets', async columns => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const squire = new BrowserSquire();
  const secret = 'sk-syntheticSensitive123456789012345';
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: 'low_confidence', question: `${stopQuestion} ${secret} "token": "table-secret"; Password "SyntheticPass!42"`, confidence: 0.32,
      reason: `No matching fact for the API key name field. Bearer short-value ${secret}; API key 123e4567-e89b-12d3-a456-426614174000 was rejected; "api_key": "quoted-value"; Password "SyntheticPass!42"; Password Swordfish was rejected; Password is correct horse battery staple; API key aBcD was rejected`, session_id: 'tab' } : {});
  const output: string[] = [];
  const table = new SetupTable({ isTTY: columns !== undefined, ...(columns ? { columns } : {}),
    write: ((text: string) => { output.push(text); return true; }) as NodeJS.WriteStream['write'] });
  await setupFallbacks({ directory, squire, adapters: ['zro'], signal: new AbortController().signal,
    notify: () => {}, connect: async () => {}, run: async () => {},
    setupProvider: async () => { await squire.signup('zro', 'https://zro.test', 'Capture access'); },
    onSettled: (id, available, reason) => { table.set('source', id, available ? 'ready' : `skipped (${reason})`); } });
  table.finish();
  const text = output.join('');
  expect(text).toContain(stopQuestion);
  expect(text).toContain('confidence 0.32');
  expect(text).toContain("Squire's reason: No matching fact for the API key name field. [redacted] [redacted]");
  expect(text).not.toContain(secret);
  expect(text).not.toContain('short-value');
  expect(text).not.toContain('123e4567-e89b-12d3-a456-426614174000');
  expect(text).not.toContain('quoted-value');
  expect(text).not.toContain('table-secret');
  expect(text).not.toContain('SyntheticPass!42');
  for (const secret of ['Password', 'Swordfish', 'correct', 'horse', 'battery', 'staple', 'aBcD']) expect(text).not.toContain(secret);
  expect(text).not.toContain('https://zro.test/api-keys');
  await squire.close();
});

it.each(['rejected', 'page'])('preserves benign key diagnostics at refusal/page and debug boundaries (%s)', async status => {
  vi.stubEnv('GRUNT_SETUP_DEBUG', '1');
  directory = await mkdtemp(join(tmpdir(), 'grunt-drop-reason-'));
  const diagnostic = 'No matching fact for the API key name field';
  const secrets = ['sk-short', 'sk_short', 'gsk_short', 'nvapi-short', 'ghp_short', 'freellmapi-short',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'basic-value', 'bearer-value', 'synthetic-sensitive-value', '123e4567-e89b-12d3-a456-426614174000', 'quoted-value', 'single-quoted-value', 'SyntheticPass!42', 'SyntheticToken!42', 'BarePass!42', 'Swordfish', 'correct horse battery staple', 'aBcD'];
  const message = `${diagnostic}; ${secrets.slice(0, 8).join(' ')} Basic basic-value Bearer bearer-value secret is synthetic-sensitive-value; API key 123e4567-e89b-12d3-a456-426614174000 was rejected; ${JSON.stringify({ api_key: 'quoted-value' })}; 'password': 'single-quoted-value'; Password "SyntheticPass!42" was rejected; token 'SyntheticToken!42' was rejected; Password BarePass!42 was rejected; Password Swordfish was rejected; Password is correct horse battery staple; API key aBcD was rejected`;
  const squire = new BrowserSquire();
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive'
    ? { status: status === 'page' ? 'stuck' : 'rejected', session_id: 'tab',
      ...(status === 'page' ? { observation: { dom: JSON.stringify({ detail: message }), safe_table: [] } } : { reason: message }),
      question: `${stopQuestion} ${message}`, confidence: 0.32,
      remaining: message, field: message, needs_user: { wall: message, message }, error: message } : {});
  const output: string[] = [];
  const debug = vi.spyOn(console, 'error').mockImplementation(line => { output.push(String(line)); });
  await setupFallbacks({ directory, squire, adapters: ['zro'], signal: new AbortController().signal,
    notify: line => { output.push(line); }, connect: async () => {}, run: async () => {},
    setupProvider: async () => { await squire.signup('zro', 'https://zro.test', 'Capture access'); },
    onSettled: (_id, _available, reason) => { output.push(reason ?? ''); } });
  expect(output.join('\n')).toContain(diagnostic);
  expect(output.join('\n')).toContain('confidence 0.32');
  expect(output.join('\n')).toContain(stopQuestion);
  expect(debug).toHaveBeenCalledWith(expect.stringContaining(diagnostic));
  for (const secret of secrets) expect(output.join('\n')).not.toContain(secret);
  await squire.close();
});
