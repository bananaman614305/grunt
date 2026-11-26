import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasOwnerMode, openPrivateFile } from './private-file.js';

const filename = 'squire-client-path';
const packagedClient = () => join(dirname(fileURLToPath(import.meta.resolve('@trusty-squire/mcp'))), 'bin.js');

export async function saveSquireClientPath(directory: string) {
  const temporary = join(directory, `.${filename}-${randomUUID()}`);
  try {
    await writeFile(temporary, packagedClient(), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, filename));
  } finally { await rm(temporary, { force: true }); }
}

export async function squireClientPath(directory: string) {
  if (typeof GRUNT_DAEMON_BUNDLE === 'undefined') return packagedClient();
  // The CLI owns this optional dependency. Its path can change after npx
  // cache cleanup, so setup refreshes the hint outside the swapped runtime.
  const message = 'Connect Trusty Squire separately, then rerun usegrunt setup';
  const file = await openPrivateFile(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new Error(message); });
  try {
    const info = await file.stat();
    if (!info.isFile() || !hasOwnerMode(info, 0o600) || info.size > 32768) throw new Error(message);
    const path = await file.readFile('utf8');
    if (!isAbsolute(path) || path.includes('\0')) throw new Error(message);
    return path;
  } finally { await file.close(); }
}
