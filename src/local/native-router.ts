import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { command, configDir, installBackgroundService } from './wizard.js';
import { loopback } from './freellmapi.js';

// Published FreeLLMAPI v0.16.24 source, pinned independently of grunt releases.
export const FREELLMAPI_REVISION = '4c8c2f834b587b6acc3f00698ad8f6468bea1aa2';
export async function ensureNativeRouter() {
  if (!['linux', 'darwin'].includes(process.platform)) throw new Error('grunt setup requires Linux or macOS');
  const directory = join(configDir(), 'freellmapi'), source = join(directory, 'source');
  const entry = join(source, 'server', 'dist', 'index.js');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let installed = false;
  try { await access(join(directory, FREELLMAPI_REVISION)); await access(entry); installed = true; } catch { /* First install or interrupted build. */ }
  if (!installed) {
    const archive = join(directory, 'source.tar.gz');
    const response = await fetch(`https://codeload.github.com/tashfeenahmed/freellmapi/tar.gz/${FREELLMAPI_REVISION}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('Cannot download the pinned FreeLLMAPI Node server');
    await writeFile(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    await mkdir(source, { recursive: true, mode: 0o700 });
    await command('tar', ['-xzf', archive, '--strip-components=1', '-C', source]);
    await rm(archive);
    await command('npm', ['install', '--prefix', source, '--ignore-scripts', '--no-audit', '--no-fund']);
    await command('npm', ['rebuild', '--prefix', source, 'better-sqlite3', 'sharp']);
    await command(process.execPath, [join(source, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', join(source, 'server', 'tsconfig.json')]);
    await writeFile(join(directory, FREELLMAPI_REVISION), '', { mode: 0o600 });
  }
  const runner = join(directory, 'runner.mjs');
  // Only the backend reads this login; systemd/launchd files contain no secrets.
  await writeFile(runner, `import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
process.umask(0o077);
const path = join(process.env.MILO_CONFIG_DIR, 'router-admin.json');
const metadata = await stat(path);
if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid()) throw new Error('Invalid private router login permissions');
const admin = JSON.parse(await readFile(path, 'utf8'));
process.env.ENCRYPTION_KEY = admin.encryption;
process.env.FREEAPI_CONFIG_JSON = JSON.stringify({ admin: { email: 'milo@localhost.local', password: admin.password } });
await import(pathToFileURL(process.env.MILO_ROUTER_ENTRY).href);
`, { mode: 0o600 });
  const url = loopback(process.env.MILO_FREELLMAPI_URL || 'http://127.0.0.1:3001/v1');
  await mkdir(dirname(join(directory, 'router.db')), { recursive: true, mode: 0o700 });
  await installBackgroundService('milo-router', runner, {
    MILO_CONFIG_DIR: configDir(), MILO_ROUTER_ENTRY: entry,
    HOST: '127.0.0.1', PORT: url.port || '80', NODE_ENV: 'production',
    FREEAPI_DB_PATH: join(directory, 'router.db'),
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
  });
}
