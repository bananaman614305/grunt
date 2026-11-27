import { lstat, open } from 'node:fs/promises';
import type { Stats } from 'node:fs';

// Windows uses the ACL inherited from the user's profile instead of Unix IDs
// and permission bits. Keep the caller's file type and size checks on both.
export function hasOwnerMode(stat: Stats, mode: number, mask = 0o777) {
  return process.platform === 'win32' || (stat.uid === process.getuid?.() && (stat.mode & mask) === mode);
}

export async function openPrivateFile(path: string, flags: number, mode?: number) {
  if (process.platform !== 'win32') return open(path, flags, mode);
  const unsafe = () => new Error('Expected a regular file in the Grunt configuration directory');
  const before = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  if (before && !before.isFile()) throw unsafe();
  const file = await open(path, flags, mode);
  try {
    const [info, current] = await Promise.all([file.stat(), lstat(path)]);
    if (!current.isFile() || !info.isFile() || info.dev !== current.dev || info.ino !== current.ino) throw unsafe();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
