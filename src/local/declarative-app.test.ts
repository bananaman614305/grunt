import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DECLARATIVE_APP_INSTALL } from '../registry.js';
import type { DeclarativeAppAdapter } from '../registry.js';
import { detectSandboxBackend } from './app-sandbox.js';
import { declarativeAppDataSharingPolicy, recordDataSharingConsent } from './data-sharing.js';
import { DeclarativeApp, isDeclarativeAppBackedOff, setupDeclarativeApp } from './declarative-app.js';
import { canReplay, Sources } from './source.js';

const tempDirs: string[] = [];
async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function packCliTarGz(name: string, script: string): Promise<Buffer> {
  const src = await makeTemp('grunt-cli-pack-');
  await writeFile(join(src, name), script, { mode: 0o755 });
  const out = join(src, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', src, name]);
  return readFile(out);
}

describe('DeclarativeApp end-to-end inside real bwrap', () => {
  it('supports browser-url auth (via xdg-open), single-login reuse, delegated oneshot-exec continuation, replay safety, and quiet maintenance', async () => {
    const backend = await detectSandboxBackend();
    if (!backend || backend.kind !== 'bwrap') return;

    const configDir = await makeTemp('grunt-dapp-oneshot-');
    const hostProjectDir = await makeTemp('grunt-secret-project-');
    await writeFile(join(hostProjectDir, '.env'), 'SECRET=should_never_be_mounted\n');

    const cliScript = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const cp = require("node:child_process");',
      'const tokenPath = path.join(process.env.HOME, "auth.json");',
      'const args = process.argv.slice(2);',
      'if (args[0] === "login") {',
      '  cp.spawnSync("xdg-open", ["https://auth.mockcli.example/cli/pair?id=42"], { stdio: "ignore" });',
      '  fs.writeFileSync(tokenPath, JSON.stringify({ ok: true }));',
      '  process.exit(0);',
      '}',
      'if (args[0] === "status") {',
      '  if (fs.existsSync(tokenPath)) { console.log("signed-in"); process.exit(0); }',
      '  console.log("signed-out"); process.exit(1);',
      '}',
      'const pIdx = args.indexOf("-p");',
      'const prompt = pIdx >= 0 ? args[pIdx + 1] : "";',
      'const rIdx = args.indexOf("--resume");',
      'const resume = rIdx >= 0 ? args[rIdx + 1] : null;',
      'if (prompt === "FAIL_AFTER_DISPATCH") { console.error("unexpected crash"); process.exit(1); }',
      'if (prompt === "QUOTA_HIT") { console.error("Daily quota exceeded"); process.exit(1); }',
      `const leakedProject = fs.existsSync(${JSON.stringify(join(hostProjectDir, '.env'))});`,
      'console.log(JSON.stringify({',
      '  session_id: resume || "sess_001",',
      '  reply: { text: `echo:${prompt}|resume:${resume || "none"}|leaked:${leakedProject}` }',
      '}));'
    ].join('\n') + '\n';
    const archiveBytes = await packCliTarGz('mock-cli', cliScript);

    const adapter: DeclarativeAppAdapter = {
      id: 'mock-oneshot',
      kind: 'agent',
      tier: 'experimental',
      weight: 0.01,
      modalities: ['text'],
      install: DECLARATIVE_APP_INSTALL,
      signup: 'https://auth.mockcli.example/login',
      hints: 'Press Authorize.',
      declarativeApp: {
        execution: 'delegated',
        installer: {
          type: 'archive',
          urls: {
            'linux-x64': 'https://releases.mockcli.example/mock-cli.tar.gz',
            'linux-arm64': 'https://releases.mockcli.example/mock-cli.tar.gz'
          },
          bin: 'mock-cli'
        },
        auth: {
          type: 'browser-url',
          command: ['login'],
          allowedOrigins: ['https://auth.mockcli.example'],
          authFile: 'auth.json',
          statusArgs: ['status'],
          statusMatch: 'signed-in'
        },
        transport: {
          type: 'oneshot-exec',
          args: ['-p', '{{prompt}}'],
          promptInput: 'arg',
          resumeArgs: ['--resume', '{{sessionId}}'],
          output: { format: 'json', textPath: 'reply.text', sessionIdPath: 'session_id' },
          errors: { quota: 'quota exceeded' }
        },
        disclosure: 'Prompts go to Mock Oneshot CLI.',
        policyVersion: '2026-11-27',
        policyUrl: 'https://auth.mockcli.example/privacy',
        name: 'Mock Oneshot'
      }
    };

    await recordDataSharingConsent(configDir, [adapter.id], [declarativeAppDataSharingPolicy(adapter)]);

    const signup = vi.fn(async () => {});
    const notices: string[] = [];
    await setupDeclarativeApp(adapter, {
      directory: configDir,
      squire: { signup },
      notify: line => notices.push(line),
      background: false,
      backend,
      fetcher: async () => new Response(archiveBytes, { status: 200 })
    });
    expect(signup).toHaveBeenCalledTimes(1);
    expect(signup.mock.calls[0]![1]).toBe('https://auth.mockcli.example/cli/pair?id=42');

    // Second setup reuses existing login without opening Squire again
    await setupDeclarativeApp(adapter, {
      directory: configDir,
      squire: { signup },
      notify: line => notices.push(line),
      background: false,
      backend,
      fetcher: async () => new Response(archiveBytes, { status: 200 })
    });
    expect(signup).toHaveBeenCalledTimes(1);

    const source = new DeclarativeApp(adapter.id, { directory: configDir, adapter: () => adapter, backend });
    expect(source.supportsFunctionTools).toBe(false);
    expect(source.metadataOnlyMaintenance).toBe(true);
    expect(await source.available()).toBe(true);

    // Turn 1: natural user text, host project .env NOT mounted
    const r1 = await source.complete({
      model: adapter.id,
      cwd: hostProjectDir,
      messages: [{ role: 'user', content: 'first task' }],
      tools: [],
      stream: false
    }, AbortSignal.timeout(15000));
    expect(r1.text).toBe('echo:first task|resume:none|leaked:false');

    // Turn 2: continues with session_id sess_001
    const r2 = await source.complete({
      model: adapter.id,
      cwd: hostProjectDir,
      messages: [
        { role: 'user', content: 'first task' },
        { role: 'assistant', content: r1.text },
        { role: 'user', content: 'follow up' }
      ],
      tools: [],
      stream: false
    }, AbortSignal.timeout(15000));
    expect(r2.text).toBe('echo:follow up|resume:sess_001|leaked:false');

    // Delegated post-dispatch crash is marked replay-unsafe
    try {
      await source.complete({
        model: adapter.id,
        cwd: hostProjectDir,
        messages: [{ role: 'user', content: 'FAIL_AFTER_DISPATCH' }],
        tools: [],
        stream: false
      }, AbortSignal.timeout(15000));
      expect.unreachable('should fail');
    } catch (err) {
      expect(canReplay(err as never)).toBe(false);
    }

    // Quota error classification
    await expect(source.complete({
      model: adapter.id,
      cwd: hostProjectDir,
      messages: [{ role: 'user', content: 'QUOTA_HIT' }],
      tools: [],
      stream: false
    }, AbortSignal.timeout(15000))).rejects.toMatchObject({ code: 'quota' });

    // Quiet metadata-only maintenance (does not run an inference prompt)
    const completeSpy = vi.spyOn(source, 'complete');
    const sources = new Sources([source]);
    const check = await sources.check(adapter.id, AbortSignal.timeout(15000));
    expect(check).toEqual({ outcome: 'passed', evidence: 'metadata' });
    expect(completeSpy).not.toHaveBeenCalled();

    await source.close();
  });

  it('supports ACP inference mode with JsonToolBridge inside bwrap and refuses native ACP tool_call notifications', async () => {
    const backend = await detectSandboxBackend();
    if (!backend || backend.kind !== 'bwrap') return;

    const configDir = await makeTemp('grunt-dapp-acp-');
    const acpScript = [
      '#!/usr/bin/env node',
      'const readline = require("node:readline");',
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on("line", line => {',
      '  if (!line.trim()) return;',
      '  const msg = JSON.parse(line);',
      '  if (msg.method === "initialize") {',
      '    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "mock-acp", version: "1.0.0" } } }));',
      '  } else if (msg.method === "session/new") {',
      '    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "acp_sess_1" } }));',
      '  } else if (msg.method === "session/prompt") {',
      '    const text = msg.params.prompt[0].text;',
      '    if (text.includes("TRIGGER_NATIVE_TOOL")) {',
      '      console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp_sess_1", update: { sessionUpdate: "tool_call", name: "bash" } } }));',
      '      return;',
      '    }',
      '    const reply = text.includes("You are answering a tool-calling request")',
      '      ? JSON.stringify({ version: 1, type: "calls", calls: [{ name: "read_file", arguments: { path: "a.txt" } }] })',
      '      : "plain acp answer";',
      '    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "acp_sess_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } }));',
      '    console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } }));',
      '  }',
      '});'
    ].join('\n') + '\n';
    const archiveBytes = await packCliTarGz('mock-acp', acpScript);

    const adapter: DeclarativeAppAdapter = {
      id: 'mock-acp',
      kind: 'model',
      tier: 'experimental',
      weight: 0.01,
      modalities: ['text'],
      install: DECLARATIVE_APP_INSTALL,
      declarativeApp: {
        execution: 'inference',
        installer: {
          type: 'archive',
          urls: {
            'linux-x64': 'https://releases.mockacp.example/mock-acp.tar.gz',
            'linux-arm64': 'https://releases.mockacp.example/mock-acp.tar.gz'
          },
          bin: 'mock-acp'
        },
        auth: { type: 'none' },
        transport: { type: 'acp', args: ['acp'] },
        disclosure: 'Prompts go to Mock ACP.',
        policyVersion: '2026-11-27',
        policyUrl: 'https://mockacp.example/privacy',
        name: 'Mock ACP'
      }
    };

    await recordDataSharingConsent(configDir, [adapter.id], [declarativeAppDataSharingPolicy(adapter)]);
    await setupDeclarativeApp(adapter, {
      directory: configDir,
      squire: {},
      notify: () => {},
      background: true,
      backend,
      fetcher: async () => new Response(archiveBytes, { status: 200 })
    });

    const source = new DeclarativeApp(adapter.id, { directory: configDir, adapter: () => adapter, backend });
    expect(source.supportsFunctionTools).toBe(true);
    expect(source.jsonToolBridge).toBe(true);
    expect(source.inferenceOnly).toBe(true);

    const toolReply = await source.complete({
      model: 'grunt',
      cwd: configDir,
      messages: [{ role: 'user', content: 'read a.txt' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
      stream: false
    }, AbortSignal.timeout(15000));
    expect(toolReply.calls).toHaveLength(1);
    expect(toolReply.calls![0]!.function.name).toBe('read_file');
    expect(JSON.parse(toolReply.calls![0]!.function.arguments)).toEqual({ path: 'a.txt' });

    // Refuses unexpected native tool_call in inference mode
    await expect(source.complete({
      model: 'grunt',
      cwd: configDir,
      messages: [{ role: 'user', content: 'TRIGGER_NATIVE_TOOL' }],
      tools: [],
      stream: false
    }, AbortSignal.timeout(15000))).rejects.toMatchObject({ code: 'refused' });

    await source.close();
  });

  it('records durable signup backoff when browser login fails', async () => {
    const backend = await detectSandboxBackend();
    if (!backend || backend.kind !== 'bwrap') return;

    const configDir = await makeTemp('grunt-dapp-backoff-');
    const cliScript = '#!/usr/bin/env node\nconsole.log("https://auth.fail.example/go"); process.exit(1);\n';
    const archiveBytes = await packCliTarGz('fail-cli', cliScript);

    const adapter: DeclarativeAppAdapter = {
      id: 'fail-app',
      kind: 'agent',
      tier: 'experimental',
      weight: 0.01,
      modalities: ['text'],
      install: DECLARATIVE_APP_INSTALL,
      declarativeApp: {
        execution: 'delegated',
        installer: {
          type: 'archive',
          urls: { 'linux-x64': 'https://releases.fail.example/fail-cli.tar.gz', 'linux-arm64': 'https://releases.fail.example/fail-cli.tar.gz' },
          bin: 'fail-cli'
        },
        auth: { type: 'browser-url', command: ['login'], allowedOrigins: ['https://auth.fail.example'], authFile: 'token.json' },
        transport: { type: 'oneshot-exec', args: ['{{prompt}}'], promptInput: 'arg', output: { format: 'plain' } },
        disclosure: 'Prompts go to Fail App.',
        policyVersion: '2026-11-27',
        policyUrl: 'https://auth.fail.example/privacy'
      }
    };
    await recordDataSharingConsent(configDir, [adapter.id], [declarativeAppDataSharingPolicy(adapter)]);
    await expect(setupDeclarativeApp(adapter, {
      directory: configDir,
      squire: { signup: async () => { throw new Error('user refused'); } },
      notify: () => {},
      background: false,
      backend,
      fetcher: async () => new Response(archiveBytes, { status: 200 })
    })).rejects.toThrow();

    expect(await isDeclarativeAppBackedOff(adapter.id, configDir)).toBe(true);

    // Subsequent immediate retry is rejected under the lock by durable backoff without launching Squire.
    const secondSignup = vi.fn(async () => {});
    await expect(setupDeclarativeApp(adapter, {
      directory: configDir,
      squire: { signup: secondSignup },
      notify: () => {},
      background: false,
      backend,
      fetcher: async () => new Response(archiveBytes, { status: 200 })
    })).rejects.toThrow(/backed off/i);
    expect(secondSignup).not.toHaveBeenCalled();
  });

  it('serializes concurrent setup calls so only one login runs and persists backoff before login starts', async () => {
    const backend = await detectSandboxBackend();
    if (!backend || backend.kind !== 'bwrap') return;

    const configDir = await makeTemp('grunt-dapp-lock-');
    const cliScript = [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const cp = require("node:child_process");',
      'const tokenPath = path.join(process.env.HOME, "auth.json");',
      'const args = process.argv.slice(2);',
      'if (args[0] === "login") {',
      '  cp.spawnSync("xdg-open", ["https://auth.lock.example/pair"], { stdio: "ignore" });',
      '  setTimeout(() => { fs.writeFileSync(tokenPath, JSON.stringify({ ok: true })); process.exit(0); }, 150);',
      '} else if (args[0] === "hang") {',
      '  console.log("https://auth.lock.example/hang");',
      '  setInterval(() => {}, 1000);',
      '}'
    ].join('\n') + '\n';
    const archiveBytes = await packCliTarGz('lock-cli', cliScript);

    const adapter: DeclarativeAppAdapter = {
      id: 'lock-app',
      kind: 'agent',
      tier: 'experimental',
      weight: 0.01,
      modalities: ['text'],
      install: DECLARATIVE_APP_INSTALL,
      declarativeApp: {
        execution: 'delegated',
        installer: {
          type: 'archive',
          urls: { 'linux-x64': 'https://releases.lock.example/lock-cli.tar.gz', 'linux-arm64': 'https://releases.lock.example/lock-cli.tar.gz' },
          bin: 'lock-cli'
        },
        auth: { type: 'browser-url', command: ['login'], allowedOrigins: ['https://auth.lock.example'], authFile: 'auth.json' },
        transport: { type: 'oneshot-exec', args: ['{{prompt}}'], promptInput: 'arg', output: { format: 'plain' } },
        disclosure: 'Prompts go to Lock App.',
        policyVersion: '2026-11-27',
        policyUrl: 'https://auth.lock.example/privacy'
      }
    };
    await recordDataSharingConsent(configDir, [adapter.id], [declarativeAppDataSharingPolicy(adapter)]);

    // Launch two concurrent setups: only one browser login may run, and backoff must already be
    // persisted on disk while the login is in flight (before squire.signup resolves).
    let backedOffDuringLogin = false;
    const signup = vi.fn(async () => {
      backedOffDuringLogin = await isDeclarativeAppBackedOff(adapter.id, configDir);
    });
    const runSetup = () => setupDeclarativeApp(adapter, {
      directory: configDir,
      squire: { signup },
      notify: () => {},
      background: false,
      backend,
      fetcher: async () => new Response(archiveBytes, { status: 200 })
    });
    await Promise.all([runSetup(), runSetup()]);
    expect(signup).toHaveBeenCalledTimes(1);
    expect(backedOffDuringLogin).toBe(true);
    // Once login succeeds, backoff is cleared under the same lock.
    expect(await isDeclarativeAppBackedOff(adapter.id, configDir)).toBe(false);

    // Mid-login interruption (abort) leaves durable backoff persisted on disk.
    const abortDir = await makeTemp('grunt-dapp-abort-');
    const hangAdapter: DeclarativeAppAdapter = {
      ...adapter,
      id: 'hang-app',
      declarativeApp: {
        ...adapter.declarativeApp,
        auth: { type: 'browser-url', command: ['hang'], allowedOrigins: ['https://auth.lock.example'], authFile: 'auth.json' }
      }
    };
    await recordDataSharingConsent(abortDir, [hangAdapter.id], [declarativeAppDataSharingPolicy(hangAdapter)]);
    const controller = new AbortController();
    await expect(setupDeclarativeApp(hangAdapter, {
      directory: abortDir,
      signal: controller.signal,
      squire: {
        signup: async () => {
          controller.abort(new Error('interrupted'));
        }
      },
      notify: () => {},
      background: false,
      backend,
      fetcher: async () => new Response(archiveBytes, { status: 200 })
    })).rejects.toThrow();
    expect(await isDeclarativeAppBackedOff(hangAdapter.id, abortDir)).toBe(true);
  });
});
