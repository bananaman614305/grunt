// Run after a clean frozen installation and build. No provider signup occurs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

if (process.argv.includes('--connect-child')) {
  const { BrowserSquire } = await import('../../dist/local/setup.js');
  const squire = new BrowserSquire();
  try { await squire.connect(); console.log('Squire connected'); }
  catch (error) { console.error(error.message); }
  finally { await squire.close(); }
} else {
  const require = createRequire(import.meta.resolve('@trusty-squire/mcp'));
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const sqlite = db.prepare('select sqlite_version() as version').get().version;
  db.close();
  const dir = await mkdtemp(join(tmpdir(), 'milo-squire-install-'));
  const registry = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: '1.1.39' })); });
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(join(dir, 'bin'));
    // Refuse service operations so this proof cannot install/start a broker.
    await writeFile(join(dir, 'bin', 'systemctl'), '#!/bin/sh\nprintf "Offline proof: no user service manager\\n" >&2\nexit 1\n');
    await chmod(join(dir, 'bin', 'systemctl'), 0o755);
    const env = { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), XDG_CACHE_HOME: join(dir, 'cache'), TRUSTY_SQUIRE_PROFILE_DIR: join(dir, 'profile'), TRUSTY_SQUIRE_BROKER_SOCKET: join(dir, 'absent.sock'), TRUSTY_SQUIRE_NPM_REGISTRY: `http://127.0.0.1:${registry.address().port}` };
    delete env.TRUSTY_SQUIRE_ACCOUNT_ID;
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--connect-child'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; process.kill(-child.pid, 'SIGTERM'); }, 25000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    assert(!timedOut, 'Squire connection reaches a bounded setup result');
    assert.equal(code, 0, 'proof child completes normally');
    assert(!/Could not locate the bindings file|better_sqlite3\.node|ERR_DLOPEN_FAILED/.test(output), 'BrowserSquire.connect loads its native dependency');
    assert(/Squire connection was not completed|Squire connected/.test(output), 'the built connector reaches Squire connection setup');
    console.log(JSON.stringify({ reproduction: 'squire-clean-install', node: process.version, sqlite, nativeBindingLoaded: true, builtConnector: 'BrowserSquire.connect reached connection setup without a native binding error', outcome: output.includes('Squire connected') ? 'connected' : 'stopped at isolated Squire connection setup', providerSignups: false }, null, 2));
  } finally { registry.closeAllConnections(); registry.close(); await rm(dir, { recursive: true, force: true }); }
}
