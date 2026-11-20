import { createClient } from '@libsql/client';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SourceError } from './source.js';

// SQLite owns the write lock. The OS releases it on process death; we never
// steal a live owner's lease based on time, PID files, or deletion of a path.
export async function acquireFreePiAccountLease(subject: string, root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) throw new SourceError('refused', 'Free-Pi account lock directory is unsafe');
  const path = join(root, `${createHash('sha256').update(subject).digest('hex')}.sqlite`);
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new SourceError('refused', 'Free-Pi account lock is unsafe');
  } finally { await file.close(); }
  const db = createClient({ url: pathToFileURL(path).href, concurrency: 1 });
  try {
    await db.execute('PRAGMA busy_timeout=0');
    const transaction = await db.transaction('write');
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { await transaction.rollback(); } finally { db.close(); }
    };
  } catch (error) {
    db.close();
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') throw new SourceError('quota', 'Free-Pi account already has an active Grunt request; retry later', 30);
    throw new SourceError('upstream', 'Free-Pi account concurrency guard is unavailable');
  }
}
