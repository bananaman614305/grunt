import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { applyWorkerArtifact, type ApplicableWorkerArtifact } from './worker-integration.js';

const hooks = vi.hoisted(() => ({ link: undefined as undefined | ((source: string, target: string) => Promise<void>),
  rename: undefined as undefined | ((source: string, target: string) => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof fs>();
  return { ...real, rename: async (source: string, target: string) => {
    await hooks.rename?.(String(source), String(target));
    return real.rename(source, target);
  }, link: async (source: string, target: string) => {
    await hooks.link?.(String(source), String(target));
    return real.link(source, target);
  } };
});
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const file = (path: string, before: string | null, after: string | null) => ({ path,
  beforeSha256: before === null ? null : sha(before), afterSha256: after === null ? null : sha(after),
  ...(after === null ? { deleted: true } : { content: after }) });
const artifact = (...files: ApplicableWorkerArtifact['files']): ApplicableWorkerArtifact => ({ complete: true, truncated: false, files });
const options = { ownedPaths: ['src', 'assets'] };
let root: string;
beforeEach(async () => {
  hooks.link = undefined; hooks.rename = undefined;
  root = await fs.mkdtemp(join(tmpdir(), 'grunt-integration-'));
  await fs.mkdir(join(root, '.git'));
  await fs.mkdir(join(root, 'src'));
});
afterEach(async () => { hooks.link = undefined; hooks.rename = undefined; await fs.rm(root, { recursive: true, force: true }); });
const apply = (value: ApplicableWorkerArtifact, signal?: AbortSignal) => applyWorkerArtifact(root, value, options, signal);
const write = (name: string, value: string) => fs.writeFile(join(root, name), value);
const read = (name: string) => fs.readFile(join(root, name), 'utf8');

describe('reviewed worker artifact integration in the caller filesystem', () => {
  it('accepts the full 256-file bound produced by scoped workers', async () => {
    const files = Array.from({ length: 256 }, (_, i) => file(`src/batch-${i}.txt`, null, `verified ${i}`));
    const result = await apply(artifact(...files));
    expect(result.ok).toBe(true); expect(result.appliedFiles).toHaveLength(256);
    expect(await read('src/batch-255.txt')).toBe('verified 255');
  });
  it('atomically installs file content, new directories, binary assets and deletions, retaining recovery originals', async () => {
    await write('src/update.ts', 'before');
    await write('src/delete.ts', 'delete');
    await fs.chmod(join(root, 'src/update.ts'), 0o640);
    const binary = Buffer.from([0, 128, 255, 10]);
    const result = await apply(artifact(file('src/update.ts', 'before', 'after'), file('src/deep/new.ts', null, 'new'),
      file('src/delete.ts', 'delete', null), { path: 'assets/image.bin', beforeSha256: null,
        afterSha256: sha(binary), binary: true, content: binary.toString('base64') }));
    expect(result.ok).toBe(true);
    expect(result.appliedFiles).toHaveLength(4);
    expect(result.journalPath).toContain('/.git/grunt-worker-integrations/transaction-');
    expect(result.warning).toBeUndefined();
    expect(await read('src/update.ts')).toBe('after');
    expect((await fs.stat(join(root, 'src/update.ts'))).mode & 0o777).toBe(0o640);
    expect(await read('src/deep/new.ts')).toBe('new');
    expect(await fs.readFile(join(root, 'assets/image.bin'))).toEqual(binary);
    await expect(read('src/delete.ts')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(join(result.journalPath!, 'before-0'), 'utf8')).toBe('before');
    expect(await fs.readFile(join(result.journalPath!, 'before-2'), 'utf8')).toBe('delete');
    expect((await fs.stat(result.journalPath!)).mode & 0o777).toBe(0o700);
  });
  it('allows exact captured dirty baselines without invoking git or merging', async () => {
    await write('src/a', 'unsaved-to-git-parent-change');
    expect((await apply(artifact(file('src/a', 'unsaved-to-git-parent-change', 'reviewed')))).ok).toBe(true);
    expect(await read('src/a')).toBe('reviewed');
  });
  it('checks all baselines before any project content or journal changes', async () => {
    await write('src/a', 'a'); await write('src/b', 'parent-edited');
    const result = await apply(artifact(file('src/a', 'a', 'new-a'), file('src/b', 'old-b', 'new-b')));
    expect(result).toMatchObject({ ok: false, code: 'conflict', rollback: 'not_needed', conflicts: ['src/b'] });
    expect(await read('src/a')).toBe('a'); expect(await read('src/b')).toBe('parent-edited');
    expect(await fs.readdir(join(root, '.git'))).toEqual([]);
  });
  it.each([['incomplete', { complete: false }], ['truncated', { truncated: true }]])('rejects %s even with allowPartial', async (_name, flags) => {
    const result = await applyWorkerArtifact(root, { ...artifact(file('src/a', null, 'a')), ...flags }, { ...options, allowPartial: true });
    expect(result.code).toBe('invalid_artifact'); expect(await fs.readdir(join(root, 'src'))).toEqual([]);
  });
  it.each(['../escape', '/absolute', 'src/../escape', 'src//a', 'src/a\\b', 'src/a:b', 'src/a\n', '.git/config',
    'src/.env', 'src/credentials-test', 'src/.grunt-workspace-proof', 'src/key.pem', 'src/.ssh/config', 'src/CON'])('rejects dangerous path %j', async path => {
    const result = await applyWorkerArtifact(root, artifact(file(path, null, 'x')), { ownedPaths: ['src', '.git'] });
    expect(result.code).toBe('invalid_path');
  });
  it('rejects out-of-ownership paths and prefix lookalikes', async () => {
    expect((await applyWorkerArtifact(root, artifact(file('src/abc', null, 'x')), { ownedPaths: ['src/a'] })).code).toBe('outside_ownership');
  });
  it.each([[], ['.'], ['../x']])('requires safe explicit ownership %j', async ownedPaths => {
    expect((await applyWorkerArtifact(root, artifact(file('src/a', null, 'a')), { ownedPaths })).ok).toBe(false);
  });
  it('rejects duplicate targets and file/parent collisions', async () => {
    for (const value of [artifact(file('src/a', null, 'a'), file('src/a', null, 'b')),
      artifact(file('src/a', null, 'a'), file('src/a/b', null, 'b'))]) expect((await apply(value)).code).toBe('invalid_artifact');
  });
  it('verifies after hashes and strict binary encoding before writes', async () => {
    const wrong = { ...file('src/a', null, 'a'), content: 'forged' };
    expect((await apply(artifact(wrong))).code).toBe('invalid_artifact');
    expect((await apply(artifact({ ...file('src/a', null, 'a'), binary: true, content: 'Y Q==' }))).code).toBe('invalid_artifact');
    expect(await fs.readdir(join(root, 'src'))).toEqual([]);
  });
  it('bounds payload bytes and file count', async () => {
    expect((await apply(artifact(file('src/large', null, 'a'.repeat(1024 * 1024 + 1))))).code).toBe('invalid_artifact');
    expect((await apply(artifact(...Array.from({ length: 257 }, (_, i) => file(`src/a${i}`, null, 'x'))))).code).toBe('invalid_artifact');
  });
  it.each(['leaf', 'parent'])('rejects symlink %s without modifying its destination', async kind => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'grunt-outside-'));
    try {
      await fs.writeFile(join(outside, 'a'), 'safe');
      await fs.symlink(kind === 'leaf' ? join(outside, 'a') : outside, join(root, 'src', kind === 'leaf' ? 'a' : 'link'));
      const result = await apply(artifact(file(kind === 'leaf' ? 'src/a' : 'src/link/a', 'safe', 'bad')));
      expect(result.ok).toBe(false); expect(await fs.readFile(join(outside, 'a'), 'utf8')).toBe('safe');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
  it('rejects a symlink project root', async () => {
    const alias = join(root, 'alias'); await fs.symlink(root, alias);
    expect((await applyWorkerArtifact(alias, artifact(file('src/a', null, 'a')), options)).code).toBe('invalid_project');
  });
  it('requires absent new paths and regular existing files', async () => {
    await write('src/a', 'parent'); await fs.mkdir(join(root, 'src/directory'));
    expect((await apply(artifact(file('src/a', null, 'bad')))).code).toBe('conflict');
    expect((await apply(artifact(file('src/directory', null, 'bad')))).code).toBe('conflict');
    expect(await read('src/a')).toBe('parent');
  });
  it('honors cancellation before creating any journal', async () => {
    const controller = new AbortController(); controller.abort();
    expect((await apply(artifact(file('src/a', null, 'a')), controller.signal)).code).toBe('cancelled');
    expect(await fs.readdir(join(root, '.git'))).toEqual([]);
  });
  it('rolls back a multi-file installation failure without losing original bytes', async () => {
    await write('src/a', 'original-a'); await write('src/b', 'original-b');
    hooks.link = async source => { if (source.endsWith('/after-1')) throw new Error('synthetic disk failure'); };
    const result = await apply(artifact(file('src/a', 'original-a', 'worker-a'), file('src/b', 'original-b', 'worker-b')));
    expect(result).toMatchObject({ ok: false, code: 'io_error', rollback: 'complete' });
    expect(await read('src/a')).toBe('original-a'); expect(await read('src/b')).toBe('original-b');
    expect(await fs.readFile(join(result.journalPath!, 'before-0'), 'utf8')).toBe('original-a');
  });
  it('preserves concurrent edits and retains original backups on partial rollback', async () => {
    await write('src/a', 'original-a'); await write('src/b', 'original-b');
    hooks.link = async source => {
      if (source.endsWith('/after-1')) { await write('src/a', 'human-concurrent-edit'); throw new Error('synthetic failure'); }
    };
    const result = await apply(artifact(file('src/a', 'original-a', 'worker-a'), file('src/b', 'original-b', 'worker-b')));
    expect(result).toMatchObject({ ok: false, rollback: 'partial' });
    expect(await read('src/a')).toBe('human-concurrent-edit'); expect(await read('src/b')).toBe('original-b');
    expect(await fs.readFile(join(result.journalPath!, 'before-0'), 'utf8')).toBe('original-a');
  });
  it('never overwrites a newly created concurrent target', async () => {
    hooks.link = async source => { if (source.endsWith('/after-0')) await write('src/a', 'human-created'); };
    const result = await apply(artifact(file('src/a', null, 'worker')));
    expect(result).toMatchObject({ ok: false, code: 'conflict', rollback: 'partial' });
    expect(await read('src/a')).toBe('human-created');
  });
  it('rolls back after cancellation during a multi-file commit', async () => {
    await write('src/a', 'original'); const controller = new AbortController();
    hooks.link = async source => { if (source.endsWith('/after-0')) controller.abort(); };
    const result = await apply(artifact(file('src/a', 'original', 'worker'), file('src/b', null, 'new')), controller.signal);
    expect(result).toMatchObject({ ok: false, code: 'cancelled', rollback: 'complete' });
    expect(await read('src/a')).toBe('original'); await expect(read('src/b')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('serializes concurrent integrations so only one exact baseline wins', async () => {
    await write('src/a', 'original');
    const results = await Promise.all([apply(artifact(file('src/a', 'original', 'worker-one'))), apply(artifact(file('src/a', 'original', 'worker-two')))]);
    expect(results.filter(value => value.ok)).toHaveLength(1);
    expect(results.find(value => !value.ok)?.code).toBe('conflict');
    const winner = results.findIndex(value => value.ok);
    expect(await read('src/a')).toBe(['worker-one', 'worker-two'][winner]);
  });
  it('restores a racing parent replacement captured before installation, with its bytes retained', async () => {
    await write('src/a', 'original');
    hooks.rename = async (_source, target) => { if (target.endsWith('/before-0')) await write('src/a', 'human-before-capture'); };
    const result = await apply(artifact(file('src/a', 'original', 'worker')));
    expect(result).toMatchObject({ ok: false, code: 'conflict', rollback: 'complete' });
    expect(await read('src/a')).toBe('human-before-capture');
    expect(await fs.readFile(join(result.journalPath!, 'before-0'), 'utf8')).toBe('human-before-capture');
  });
  it('preserves a replacement racing the rollback rename instead of overwriting it with the old baseline', async () => {
    await write('src/a', 'original');
    hooks.link = async source => { if (source.endsWith('/after-1')) throw new Error('synthetic failure'); };
    hooks.rename = async (_source, target) => { if (target.includes('/rollback-')) await write('src/a', 'human-at-rollback'); };
    const result = await apply(artifact(file('src/a', 'original', 'worker'), file('src/b', null, 'b')));
    expect(result).toMatchObject({ ok: false, rollback: 'partial' });
    expect(await read('src/a')).toBe('human-at-rollback');
    expect(await fs.readFile(join(result.journalPath!, 'before-0'), 'utf8')).toBe('original');
  });
  it('does not restore a deletion over a new human-created target during recovery', async () => {
    await write('src/a', 'original');
    hooks.link = async source => { if (source.endsWith('/after-1')) { await write('src/a', 'human-created'); throw new Error('synthetic failure'); } };
    const result = await apply(artifact(file('src/a', 'original', null), file('src/b', null, 'b')));
    expect(result).toMatchObject({ ok: false, rollback: 'partial' });
    expect(await read('src/a')).toBe('human-created');
    expect(await fs.readFile(join(result.journalPath!, 'before-0'), 'utf8')).toBe('original');
  });
  it('retains backups so writes through a previously open parent descriptor survive a successful apply', async () => {
    await write('src/a', 'original');
    const handle = await fs.open(join(root, 'src/a'), 'r+');
    try {
      const result = await apply(artifact(file('src/a', 'original', 'worker')));
      expect(result.ok).toBe(true);
      await handle.truncate(0); await handle.writeFile('late-human-edit');
      expect(await read('src/a')).toBe('worker');
      expect(await fs.readFile(join(result.journalPath!, 'before-0'), 'utf8')).toBe('late-human-edit');
    } finally { await handle.close(); }
  });
  it('anchors writes during a concurrent parent-directory symlink replacement', async () => {
    await write('src/a', 'original');
    const outside = await fs.mkdtemp(join(tmpdir(), 'grunt-outside-'));
    try {
      await fs.writeFile(join(outside, 'a'), 'outside-safe');
      hooks.link = async source => {
        if (source.endsWith('/after-0')) {
          await fs.rename(join(root, 'src'), join(root, 'moved-src'));
          await fs.symlink(outside, join(root, 'src'));
        }
      };
      const result = await apply(artifact(file('src/a', 'original', 'worker')));
      expect(result).toMatchObject({ ok: false, code: 'conflict' });
      expect(await fs.readFile(join(outside, 'a'), 'utf8')).toBe('outside-safe');
      expect(await read('moved-src/a')).toBe('original');
    } finally { await fs.rm(outside, { recursive: true, force: true }); }
  });
  it('rejects a cross-process project lock without touching project content', async () => {
    const journalRoot = join(root, '.git', 'grunt-worker-integrations');
    await fs.mkdir(journalRoot, { mode: 0o700 });
    const lockPath = join(journalRoot, 'lock-' + sha(await fs.realpath(root)));
    await fs.writeFile(lockPath, 'other-client', { mode: 0o600 });
    const result = await apply(artifact(file('src/a', null, 'a')));
    expect(result).toMatchObject({ ok: false, code: 'busy', rollback: 'not_needed' });
    expect(await fs.readFile(lockPath, 'utf8')).toBe('other-client');
    await expect(read('src/a')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('uses a trusted private journal root for git worktrees', async () => {
    const journalRoot = join(root, 'actual-gitdir', 'private-journals'); await fs.mkdir(join(root, 'actual-gitdir'));
    const result = await applyWorkerArtifact(root, artifact(file('src/a', null, 'a')), { ...options, journalRoot });
    expect(result.ok).toBe(true); expect(result.journalPath).toContain(journalRoot);
  });
  it('refuses an insecure or symlink journal directory', async () => {
    const journalRoot = join(root, 'insecure'); await fs.mkdir(journalRoot, { mode: 0o755 });
    expect((await applyWorkerArtifact(root, artifact(file('src/a', null, 'a')), { ...options, journalRoot })).code).toBe('invalid_journal');
    const link = join(root, 'link'); await fs.symlink(journalRoot, link);
    expect((await applyWorkerArtifact(root, artifact(file('src/a', null, 'a')), { ...options, journalRoot: link })).code).toBe('invalid_journal');
  });
  it('reports the recoverable hidden-journal fallback for non-git projects', async () => {
    await fs.rmdir(join(root, '.git'));
    const result = await apply(artifact(file('src/a', null, 'a')));
    expect(result).toMatchObject({ ok: true, warning: 'journal_in_project' });
    expect(result.journalPath).toContain('/.grunt-workspace-integrations/');
  });
});
