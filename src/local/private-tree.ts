import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * npm creates files with the caller's umask, so a common 0002 umask leaves a
 * native CLI install group-writable and its private-install checks fail. Clear
 * group and other write bits on everything this user owns under root; symlinks
 * are left alone.
 */
export async function removeGroupWrite(root: string): Promise<void> {
  const stat = await lstat(root);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid?.()) return;
  if (stat.mode & 0o022) await chmod(root, stat.mode & 0o7777 & ~0o022);
  if (stat.isDirectory()) for (const name of await readdir(root)) await removeGroupWrite(join(root, name));
}
