import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordDataSharingConsent } from './data-sharing.js';
import { SourceRecovery } from './recovery.js';
import { SourceError, Sources } from './source.js';
import type { Source } from './source.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const directory = async () => { const dir = await mkdtemp(join(tmpdir(), 'grunt-recovery-')); dirs.push(dir); return dir; };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('source recovery', () => {
  it('adds only providers whose data-sharing consent is recorded, one run at a time', async () => {
    const dir = await directory();
    await recordDataSharingConsent(dir, ['kilo']);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const setup = vi.fn(async () => { await gate; return { unavailable: [] }; });
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['kilo', 'perch', 'zro'], notify: () => {}, setup });
    recovery.trigger(); recovery.trigger();
    await settle();
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup.mock.calls[0]![0]).toMatchObject({ adapters: ['kilo', 'zro'], background: true });
    release(); await recovery.close();
    recovery.trigger(); await settle();
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no provider can be added', async () => {
    const dir = await directory();
    const setup = vi.fn();
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['kilo'], notify: () => {}, setup });
    recovery.trigger(); await settle();
    expect(setup).not.toHaveBeenCalled();
  });

  it('keeps running after a failed run so the next exhaustion can try again', async () => {
    const dir = await directory();
    await recordDataSharingConsent(dir, ['kilo']);
    const setup = vi.fn().mockRejectedValueOnce(new Error('squire unavailable')).mockResolvedValue({ unavailable: [] });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recovery = new SourceRecovery({ directory: dir, candidates: async () => ['kilo'], notify: () => {}, setup });
    recovery.trigger(); await settle();
    recovery.trigger(); await settle();
    expect(setup).toHaveBeenCalledTimes(2);
    quiet.mockRestore();
  });
});

describe('Sources recovery trigger', () => {
  const failing = (id: string, code: SourceError['code']): Source => ({
    id, available: async () => false, complete: async () => { throw new SourceError(code, `${id} cannot answer`); }
  });
  const request = { model: 'milo', cwd: '/tmp', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], stream: false };

  it('starts recovery when no source can answer', async () => {
    const recover = vi.fn();
    const sources = new Sources([failing('opencode', 'quota')]);
    sources.setRecovery(recover);
    await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toThrow('cannot answer');
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('does not start recovery for a refusal or a timeout', async () => {
    const recover = vi.fn();
    for (const code of ['refused', 'timeout'] as const) {
      const sources = new Sources([failing('opencode', code)]);
      sources.setRecovery(recover);
      await expect(sources.complete(request, AbortSignal.timeout(1000))).rejects.toThrow();
    }
    expect(recover).not.toHaveBeenCalled();
  });

  it('does not start recovery when a source answers', async () => {
    const recover = vi.fn();
    const sources = new Sources([{ id: 'opencode', available: async () => true, complete: async () => ({ text: 'ok' }) }]);
    sources.setRecovery(recover);
    expect(await sources.complete(request, AbortSignal.timeout(1000))).toEqual({ text: 'ok' });
    expect(recover).not.toHaveBeenCalled();
  });
});
