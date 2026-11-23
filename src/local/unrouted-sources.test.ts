import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeAutomaticPool } from './automatic-pool.js';
import { configure } from './main.js';
import { answeredBy, SourceError } from './source.js';
import type { ModelRequest, Source } from './source.js';
import { bundledRegistry } from '../registry.js';

// A managed pool can keep a source with no registry entry, such as a FreeLLMAPI
// route from an earlier setup. It must not turn off routing for everything else.
const registry = { ...bundledRegistry, adapters: bundledRegistry.adapters.filter(adapter => ['opencode', 'kilo'].includes(adapter.id)) };
const request = (text: string, model = 'grunt'): ModelRequest => ({ model, messages: [{ role: 'user', content: text }], cwd: tmpdir(), tools: [], stream: false });
const signal = () => AbortSignal.timeout(3000);
let directory = '';
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'grunt-unrouted-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

async function pool(env: Record<string, string> = { GRUNT_DAEMON: '1' }, list = ['freellmapi', 'opencode', 'kilo']) {
  if (env.GRUNT_DAEMON) await writeAutomaticPool(directory, list);
  const sources = configure({ GRUNT_CONFIG_DIR: directory, GRUNT_SOURCES: list.join(','), ...env }, () => registry);
  const fake = new Map<string, { complete: ReturnType<typeof vi.fn> }>();
  for (const source of sources.sources as Source[]) {
    const complete = vi.fn(async () => ({ text: source.id }));
    Object.assign(source, { available: async () => true, complete, supportsFunctionTools: true });
    fake.set(source.id, { complete });
  }
  return { sources, fake, close: () => sources.close() };
}

it('keeps weighted and sticky routing when one managed source has no registry entry', async () => {
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { sources, fake, close } = await pool();
  try {
    // A high draw weights toward the last routed source; the low one would pick the first.
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const first = await sources.complete(request('Fix the build'), signal());
    expect(answeredBy.get(first)).toBe('kilo');
    random.mockReturnValue(0);
    expect(answeredBy.get(await sources.complete(request('Fix the build'), signal()))).toBe('kilo');
    expect(answeredBy.get(await sources.complete(request('A different task'), signal()))).toBe('opencode');
    expect(fake.get('freellmapi')!.complete).not.toHaveBeenCalled();
    expect(warning.mock.calls.map(call => String(call[0])).filter(line => line.includes('grunt routing:'))).toHaveLength(1);
  } finally { await close(); }
});

it('names the unrouted sources once and carries no secrets', async () => {
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { close } = await pool({ GRUNT_DAEMON: '1', GRUNT_FREELLMAPI_KEY: 'synthetic-secret-key' });
  try {
    const lines = warning.mock.calls.map(call => String(call[0])).filter(line => line.includes('grunt routing:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/freellmapi is not in the provider registry/);
    expect(lines[0]).not.toContain('synthetic-secret-key');
  } finally { await close(); }
});

it('uses an unrouted source only after every routed source fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { sources, fake, close } = await pool();
  try {
    expect(answeredBy.get(await sources.complete(request('first task'), signal()))).not.toBe('freellmapi');
    fake.get('opencode')!.complete.mockRejectedValue(new SourceError('upstream', 'synthetic outage'));
    fake.get('kilo')!.complete.mockRejectedValue(new SourceError('upstream', 'synthetic outage'));
    expect(answeredBy.get(await sources.complete(request('second task'), signal()))).toBe('freellmapi');
  } finally { await close(); }
});

it('reports the routed pool failure when no unrouted source can run', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { sources, fake, close } = await pool();
  try {
    fake.get('opencode')!.complete.mockRejectedValue(new SourceError('upstream', 'synthetic outage'));
    fake.get('kilo')!.complete.mockRejectedValue(new SourceError('upstream', 'synthetic outage'));
    Object.assign(sources.sources.find(source => source.id === 'freellmapi')!, { supportsFunctionTools: false });
    await expect(sources.complete({ ...request('tool task'), tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] }, signal())).rejects.toBeInstanceOf(SourceError);
    expect(fake.get('freellmapi')!.complete).not.toHaveBeenCalled();
  } finally { await close(); }
});

it('still selects an unrouted source when its model id is named, and lists it', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { sources, fake, close } = await pool();
  try {
    expect(answeredBy.get(await sources.complete(request('named', 'freellmapi'), signal()))).toBe('freellmapi');
    expect(fake.get('opencode')!.complete).not.toHaveBeenCalled();
    expect(await sources.models()).toContain('freellmapi');
    expect(sources.status().sources.find(row => row.id === 'freellmapi')?.state).not.toBe('disabled');
  } finally { await close(); }
});

it('keeps a manual GRUNT_SOURCES list as the ordered chain the person chose', async () => {
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { sources, fake, close } = await pool({});
  try {
    expect(answeredBy.get(await sources.complete(request('manual'), signal()))).toBe('freellmapi');
    expect(fake.get('opencode')!.complete).not.toHaveBeenCalled();
    expect(warning.mock.calls.some(call => String(call[0]).includes('grunt routing:'))).toBe(false);
  } finally { await close(); }
});
