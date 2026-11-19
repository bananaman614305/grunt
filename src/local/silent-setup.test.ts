import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { wizard, prepareHarnesses } from './wizard.js';
import { banner } from './banner.js';
import { BrowserSquire } from './setup.js';
import { bundledRegistry } from '../registry.js';
import { readDataSharingConsent } from './data-sharing.js';
import type { Harness } from './harnesses.js';

vi.mock('@clack/prompts', () => Object.fromEntries(['text', 'password', 'confirm', 'select', 'multiselect'].map(name => [name, vi.fn(() => { throw new Error(`Unexpected prompt: ${name}`); })])));
let directory: string;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });

it.each([[false, false], [false, true], [true, false], [true, true]])('runs the whole setup with zero prompts and enabled sharing sources (TTY: %s, key works: %s)', async (tty, keyWorks) => {
  directory = await mkdtemp(join(tmpdir(), 'grunt-silent-'));
  vi.stubEnv('GRUNT_CONFIG_DIR', directory);
  const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: tty });
  // Use a property override because Node exposes isTTY differently on pipes.
  const oldTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: tty });
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output += String(chunk); return true; });
  vi.spyOn(console, 'log').mockImplementation(line => { output += String(line) + '\n'; });
  const ids = ['opencode', 'kilo', 'tokenharbor', 'perch', 'zro'];
  const squire = new BrowserSquire();
  vi.spyOn(squire.credentials, 'list').mockResolvedValue([{ service: 'zro', reference: 'vault://test', field_names: ['api_key'] }]);
  vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'complete', session_id: 'zro-tab' } : {});
  vi.spyOn(squire, 'close').mockResolvedValue();
  const configure = vi.fn(async () => undefined);
  const tools: Harness[] = ['Pi', 'Claude Code', 'OpenCode'].map((name, index) => ({ id: (['pi', 'claude', 'opencode'] as const)[index]!, name, binary: 'node', configure,
    check: () => ({ args: [] }), launch: () => '' }));
  const run = vi.fn(async () => 'OK');
  const probes: string[] = [];
  try {
    await wizard(undefined, {
      banner: () => banner({ output: { isTTY: false, write: chunk => { output += chunk; return true; } } }),
      preflight: async () => {}, installedSources: async () => '', createSquire: () => squire,
      connectSquire: async () => {}, setup: async () => ({}), installService: async () => {}, checkService: async () => {},
      loadRegistry: async () => ({ registry: { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(adapter => ids.includes(adapter.id)) }, origin: 'bundled' }),
      prepareHarnesses: (port, options) => prepareHarnesses(port, { ...options, harnesses: tools, run }),
      setupFallbacks: async options => {
        expect(options.dataSharingApproved).toEqual(['opencode', 'kilo', 'tokenharbor', 'perch']);
        await options.onSettled?.('opencode', true);
        await options.onSettled?.('kilo', true);
        await options.onSettled?.('tokenharbor', true);
        await options.onSettled?.('perch', false);
        const result = await squire.runs.start({ service: 'zro', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' });
        await options.onSettled?.('zro', result.run.state === 'completed');
        return { unavailable: ['perch'] };
      },
      checkFallbackServices: async (unavailable, _port, _notify, selected) => {
        probes.push(...selected!);
        if (!keyWorks && selected!.includes('zro')) unavailable.push('zro');
      }
    });
    expect(configure).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledTimes(3);
    expect(probes).toEqual(['opencode', 'kilo', 'tokenharbor', 'zro']);
    expect(await readDataSharingConsent(directory, ids)).toEqual(['opencode', 'kilo', 'tokenharbor', 'perch']);
    const prompts = await import('@clack/prompts');
    for (const name of ['text', 'password', 'confirm', 'select', 'multiselect'] as const) expect(prompts[name]).not.toHaveBeenCalled();
    if (!tty) expect(output).toMatchSnapshot();
    else {
      expect(output).toContain('✓ connected');
      expect(output).toContain(keyWorks ? '✓ ready' : 'skipped (key test failed)');
      expect(output.endsWith('Ready\n')).toBe(true);
      expect(output).not.toMatch(/disclosure|personally|confirm|goal|approval|dashboard/i);
    }
  } finally {
    if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (oldTTY) Object.defineProperty(process.stdout, 'isTTY', oldTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  }
});
