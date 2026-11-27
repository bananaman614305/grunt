import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = await realpath(await mkdtemp(join(tmpdir(), 'grunt-daemon-smoke-')));
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
try {
  for (const [entry, registry] of [
    ['dist/local/daemon.mjs', 'dist/registry/adapters.json'],
    ['runtime/daemon.mjs', 'runtime/registry/adapters.json'],
  ]) {
    await mkdir(dirname(join(root, entry)), { recursive: true });
    await mkdir(dirname(join(root, registry)), { recursive: true });
    await copyFile(new URL('../dist/local/daemon.mjs', import.meta.url), join(root, entry));
    await copyFile(new URL('../dist/registry/adapters.json', import.meta.url), join(root, registry));

    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address();
    await new Promise(resolve => listener.close(resolve));

    const child = spawn(process.execPath, ['--no-addons', entry], {
      cwd: root,
      env: {
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        GRUNT_CONFIG_DIR: join(root, 'state'), GRUNT_DAEMON: '1', GRUNT_PORT: String(port), GRUNT_SOURCES: '',
        GRUNT_REGISTRY_URL: 'http://127.0.0.1:0/registry', GRUNT_BACKGROUND_ACCOUNT_ACQUISITION: '0', GRUNT_FLEET_REPORTING: '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const closed = once(child, 'close');
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', line => { stderr += line; });
    try {
      const deadline = Date.now() + 10000;
      let observation;
      while (Date.now() < deadline && child.exitCode === null) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/observe`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
        if (response?.ok) {
          observation = await response.json();
          if (observation.daemon.readiness !== 'starting') break;
        }
        await delay(50);
      }
      assert.equal(observation?.daemon.readiness, 'ready', stderr);
      assert.equal(observation.daemon.version, version);
      assert.equal(observation.diagnostics.historyAvailable, true, stderr);
      console.log(`Offline daemon smoke test passed for ${entry}`);
    } finally {
      child.kill();
      await closed;
    }
  }
} finally { await rm(root, { recursive: true, force: true }); }
