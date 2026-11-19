import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMistralVibe, setupMistralVibe } from './mistral-vibe-setup.js';
import { mistralVibePaths, readMistralVibeFreePlanReceipt, writeMistralVibeFreePlanReceipt } from './mistral-vibe.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-vibe-setup-test-')); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const receipt = () => ({ version: 1 as const, plan: 'Free' as const, payAsYouGo: false as const, paymentMethodPresent: false as const, purchasedCredits: 0 as const, checkedAt: new Date().toISOString() });
async function script(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  await chmod(path, 0o700);
}
async function installed(mode: 'success' | 'untrusted-url' | 'hang' | 'paid' = 'success') {
  const paths = mistralVibePaths(directory);
  await mkdir(paths.work, { recursive: true });
  await script(paths.binary, 'console.log("Mistral Vibe 3.1.2");');
  await script(paths.python, `
const fs=require('node:fs'),path=require('node:path');
const home=process.env.VIBE_HOME, mode=${JSON.stringify(mode)}, action=process.argv.at(-1);
fs.appendFileSync(path.join(home,'auth-invocations.jsonl'),JSON.stringify({action,keyPresent:!!process.env.MISTRAL_API_KEY,keyring:process.env.VIBE_TEST_DISABLE_KEYRING})+'\\n');
if(action==='check'){
 if(mode==='paid'||!fs.existsSync(path.join(home,'.env')))process.exit(1);
 console.log(JSON.stringify({event:'ready',plan:'Free',hasPaidVibeEntitlement:false}));
}else{
 console.log(JSON.stringify({event:'authorize',url:mode==='untrusted-url'?'https://attacker.invalid/codestral/cli/authenticate?pair=synthetic':'https://console.mistral.ai/codestral/cli/authenticate?pair=synthetic'}));
 if(mode==='hang'){
  process.on('SIGTERM',()=>{}); fs.writeFileSync(path.join(home,'owned-child.pid'),String(process.pid)); setInterval(()=>{},1000);
 }else{
  const timer=setInterval(()=>{
   if(!fs.existsSync(path.join(home,'browser-approved')))return;
   clearInterval(timer);
   if(mode==='paid')process.exit(1);
   fs.writeFileSync(path.join(home,'.env'),'MISTRAL_API_KEY=synthetic-native-key\\n',{mode:0o600});
   console.log(JSON.stringify({event:'ready',plan:'Free',hasPaidVibeEntitlement:false}));
  },10);
 }
}
`);
  return paths;
}

it('installs the pinned package through private uv directories without a global install', async () => {
  const paths = mistralVibePaths(directory), bin = join(directory, 'fake-bin');
  const uv = join(bin, 'uv');
  await script(uv, `
const fs=require('node:fs'),path=require('node:path');
const home=process.env.VIBE_HOME;
fs.writeFileSync(path.join(home,'install-evidence.json'),JSON.stringify({args:process.argv.slice(2),tool:process.env.UV_TOOL_DIR,bin:process.env.UV_TOOL_BIN_DIR,cache:process.env.UV_CACHE_DIR,python:process.env.UV_PYTHON_INSTALL_DIR}));
fs.mkdirSync(path.join(home,'bin'),{recursive:true});
fs.mkdirSync(path.join(home,'tools/mistral-vibe/bin'),{recursive:true});
fs.writeFileSync(path.join(home,'bin/vibe'),'#!${process.execPath}\\nconsole.log("Mistral Vibe 3.1.2")',{mode:0o700});
fs.writeFileSync(path.join(home,'tools/mistral-vibe/bin/python'),'#!${process.execPath}\\n',{mode:0o700});
`);
  vi.stubEnv('PATH', bin);
  await expect(installMistralVibe(directory, AbortSignal.timeout(5000))).resolves.toMatchObject({ home: paths.home });
  const evidence = JSON.parse(await readFile(join(paths.home, 'install-evidence.json'), 'utf8'));
  expect(evidence.args).toEqual(['tool', 'install', '--no-config', '--force', 'mistral-vibe==3.1.2']);
  expect(evidence).toMatchObject({ tool: join(paths.home, 'tools'), bin: join(paths.home, 'bin'), cache: join(paths.home, 'cache'), python: join(paths.home, 'python') });
  expect((await stat(paths.home)).mode & 0o777).toBe(0o700);
});

it('requires a supported local runtime when uv and Python are absent', async () => {
  vi.stubEnv('PATH', join(directory, 'missing-bin'));
  await expect(installMistralVibe(directory, AbortSignal.timeout(5000))).rejects.toThrow('uv or Python 3.12+');
});

it('verifies the Free billing state before native pairing, keeps authentication in the CLI, and writes a private receipt', async () => {
  const paths = await installed(), output: string[] = [], calls: { service: string; url: string; instructions: string }[] = [];
  vi.stubEnv('MISTRAL_API_KEY', 'synthetic-general-paid-api-key');
  const squire = { signup: vi.fn(async (service: string, url: string, instructions: string) => {
    calls.push({ service, url, instructions });
    if (new URL(url).pathname === '/codestral/cli/authenticate') await writeFile(join(paths.home, 'browser-approved'), 'yes');
  }) };
  await setupMistralVibe({ directory, squire, signal: AbortSignal.timeout(5000), notify: line => output.push(line) });
  expect(calls.map(c => c.service)).toEqual(['mistral-vibe', 'mistral-vibe']);
  expect(calls[0]?.url).toBe('https://console.mistral.ai');
  expect(calls[0]?.instructions).toContain('do not open subscription or billing pages');
  expect(calls[0]?.instructions).toContain('Never enable API or Vibe Code pay-as-you-go');
  expect(calls[1]?.instructions).toContain('the CLI owns its credential exchange');
  expect(await readMistralVibeFreePlanReceipt(directory)).toMatchObject({ ...receipt(), checkedAt: expect.any(String) });
  expect((await stat(paths.receipt)).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(output)).not.toMatch(/synthetic|authenticate|MISTRAL_API_KEY/);
  const invocation = JSON.parse((await readFile(join(paths.home, 'auth-invocations.jsonl'), 'utf8')).trim());
  expect(invocation).toMatchObject({ action: 'login', keyPresent: false, keyring: '1' });
});

it('rechecks native Free identity when reusing a current receipt without repeating browser signup', async () => {
  const paths = await installed();
  await writeMistralVibeFreePlanReceipt(directory, receipt());
  await writeFile(join(paths.home, '.env'), 'MISTRAL_API_KEY=synthetic-native-key\n', { mode: 0o600 });
  const squire = { signup: vi.fn(async () => {}) };
  await setupMistralVibe({ directory, squire, signal: AbortSignal.timeout(5000) });
  expect(squire.signup).not.toHaveBeenCalled();
  expect(JSON.parse((await readFile(join(paths.home, 'auth-invocations.jsonl'), 'utf8')).trim()).action).toBe('check');
});

it('does not issue native pairing or a receipt when Free billing verification is refused', async () => {
  const paths = await installed();
  const squire = { signup: vi.fn(async () => { throw new Error('upstream raw payload synthetic-secret'); }) };
  await expect(setupMistralVibe({ directory, squire, signal: AbortSignal.timeout(5000) })).rejects.toThrow('Free account verification did not complete');
  expect(squire.signup).toHaveBeenCalledTimes(1);
  await expect(readFile(join(paths.home, 'auth-invocations.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects a pairing URL on an unrelated origin without exposing it to Squire', async () => {
  const paths = await installed('untrusted-url');
  const squire = { signup: vi.fn(async () => {}) };
  await expect(setupMistralVibe({ directory, squire, signal: AbortSignal.timeout(5000) })).rejects.toThrow('native sign-in did not complete');
  expect(squire.signup).toHaveBeenCalledTimes(1);
  await expect(readFile(paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a native paid identity after pairing without recording Free eligibility', async () => {
  const paths = await installed('paid');
  const squire = { signup: vi.fn(async (_service, url: string) => {
    if (new URL(url).pathname === '/codestral/cli/authenticate') await writeFile(join(paths.home, 'browser-approved'), 'yes');
  }) };
  await expect(setupMistralVibe({ directory, squire, signal: AbortSignal.timeout(5000) })).rejects.toThrow('Free account could not be verified');
  await expect(readFile(paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels its own stuck native login even when it ignores SIGTERM', async () => {
  const paths = await installed('hang'), cancel = new AbortController();
  const squire = { signup: vi.fn(async (_service, url: string) => {
    if (new URL(url).pathname === '/codestral/cli/authenticate') setTimeout(() => cancel.abort(new Error('cancelled by caller')), 30);
  }) };
  await expect(setupMistralVibe({ directory, squire, signal: cancel.signal })).rejects.toThrow('cancelled by caller');
  const pid = Number(await readFile(join(paths.home, 'owned-child.pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
  await expect(readFile(paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
}, 5000);


it('redacts a late browser pairing error after the native process has already completed', async () => {
  const paths = await installed();
  const squire = { signup: vi.fn(async (_service, url: string) => {
    if (new URL(url).pathname !== '/codestral/cli/authenticate') return;
    await writeFile(join(paths.home, 'browser-approved'), 'yes');
    await new Promise(resolve => setTimeout(resolve, 100));
    throw new Error('upstream error with synthetic-secret');
  }) };
  await expect(setupMistralVibe({ directory, squire, signal: AbortSignal.timeout(5000) })).rejects.toThrow('browser pairing did not complete');
  await expect(readFile(paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('honors caller cancellation while Squire is pending after native completion', async () => {
  const paths = await installed(), cancel = new AbortController();
  const squire = { signup: vi.fn(async (_service, url: string) => {
    if (new URL(url).pathname !== '/codestral/cli/authenticate') return;
    await writeFile(join(paths.home, 'browser-approved'), 'yes');
    setTimeout(() => cancel.abort(new Error('cancel pending browser')), 100);
    await new Promise<void>(() => {});
  }) };
  await expect(setupMistralVibe({ directory, squire, signal: cancel.signal })).rejects.toThrow('cancel pending browser');
  await expect(readFile(paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
});


it('invalidates an existing Free receipt when native identity fails and browser verification refuses', async () => {
  const paths = await installed('paid');
  await writeMistralVibeFreePlanReceipt(directory, receipt());
  await writeFile(join(paths.home, '.env'), 'MISTRAL_API_KEY=synthetic-native-key\n', { mode: 0o600 });
  const squire = { signup: vi.fn(async () => { throw new Error('Existing account is now paid'); }) };
  await expect(setupMistralVibe({ directory, squire, signal: AbortSignal.timeout(5000) })).rejects.toThrow('Free account verification did not complete');
  expect(squire.signup).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await readFile(join(paths.home, 'auth-invocations.jsonl'), 'utf8')).trim()).action).toBe('check');
  await expect(readFile(paths.receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readMistralVibeFreePlanReceipt(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
