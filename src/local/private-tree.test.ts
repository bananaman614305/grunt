import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { removeGroupWrite } from './private-tree.js';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('clears group and other write bits through the tree and leaves symlinks alone', async () => {
  root = await mkdtemp(join(tmpdir(), 'private-tree-'));
  await mkdir(join(root, 'pkg', 'dist'), { recursive: true });
  await writeFile(join(root, 'pkg', 'dist', 'cli.mjs'), '');
  await writeFile(join(root, 'pkg', 'data.json'), '');
  await symlink(join(root, 'pkg', 'data.json'), join(root, 'pkg', 'link'));
  // Set modes explicitly: mkdir/writeFile modes are reduced by the test's umask.
  for (const path of [join(root, 'pkg'), join(root, 'pkg', 'dist')]) await chmod(path, 0o775);
  await chmod(join(root, 'pkg', 'dist', 'cli.mjs'), 0o775); await chmod(join(root, 'pkg', 'data.json'), 0o666);
  await removeGroupWrite(join(root, 'pkg'));
  expect((await stat(join(root, 'pkg'))).mode & 0o777).toBe(0o755);
  expect((await stat(join(root, 'pkg', 'dist'))).mode & 0o777).toBe(0o755);
  expect((await stat(join(root, 'pkg', 'dist', 'cli.mjs'))).mode & 0o777).toBe(0o755);
  expect((await stat(join(root, 'pkg', 'data.json'))).mode & 0o777).toBe(0o644);
});
