import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtDaemonPath = join(repoRoot, 'dist/local/daemon.mjs');
const buildScriptPath = join(repoRoot, 'scripts/build.mjs');
const registryPath = join(repoRoot, 'registry/adapters.json');

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function prepareStandaloneDaemon(targetPath: string) {
  await mkdir(dirname(targetPath), { recursive: true });
  const [builtStat, scriptStat] = await Promise.all([
    stat(builtDaemonPath).catch(() => undefined),
    stat(buildScriptPath),
  ]);
  // Use the built dist/local/daemon.mjs whenever it exists and is current; fall
  // back to building directly into the temp directory when tests run before `pnpm build`.
  if (builtStat && builtStat.mtimeMs >= scriptStat.mtimeMs) {
    await copyFile(builtDaemonPath, targetPath);
  } else {
    execFileSync(process.execPath, [buildScriptPath, '--daemon-only', targetPath], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  }
}

async function freePort(): Promise<number> {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

it('standalone daemon bundle has no unresolved relative require calls', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grunt-daemon-audit-')));
  tempDirs.push(root);
  const daemonPath = join(root, 'daemon.mjs');
  await prepareStandaloneDaemon(daemonPath);

  const bundle = await readFile(daemonPath, 'utf8');
  const relativeRequires = [...bundle.matchAll(/(?<![\w$])(?:[\w$]*require\d*)\(\s*['"]\.{1,2}\/[^'"]*['"]\s*\)/g)]
    .map(match => match[0]);
  expect(relativeRequires).toEqual([]);
  expect(bundle).not.toContain('./impl/format');
});

it('standalone daemon starts and runs recovery without node_modules (daemon-jsonc-umd)', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grunt-daemon-jsonc-umd-')));
  tempDirs.push(root);
  const entry = join(root, 'dist/local/daemon.mjs');
  const registry = join(root, 'dist/registry/adapters.json');
  await prepareStandaloneDaemon(entry);
  await mkdir(dirname(registry), { recursive: true });
  await copyFile(registryPath, registry);

  const port = await freePort();
  const child = spawn(process.execPath, ['--no-addons', entry, 'daemon'], {
    cwd: root,
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'xdg'),
      GRUNT_CONFIG_DIR: join(root, 'state'),
      GRUNT_DAEMON: '1',
      GRUNT_PORT: String(port),
      GRUNT_SOURCES: 'zro',
      GRUNT_REGISTRY_URL: 'http://127.0.0.1:0/registry',
      GRUNT_POSTHOG_KEY: '', GRUNT_POSTHOG_HOST: 'http://127.0.0.1:0',
      GRUNT_BACKGROUND_ACCOUNT_ACQUISITION: '1',
      GRUNT_SQUIRE_AUTO_UPDATE: '0',
      PATH: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });

  try {
    const deadline = Date.now() + 15000;
    let statusCode: number | undefined;
    while (Date.now() < deadline && child.exitCode === null) {
      if (statusCode === undefined) {
        const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
          signal: AbortSignal.timeout(1000),
        }).catch(() => undefined);
        if (response?.status === 200) statusCode = response.status;
      }
      if (statusCode === 200 && (stderr.includes('grunt routes: opening zro') || stderr.includes('Cannot find module') || stderr.includes('grunt recovery stopped:'))) {
        break;
      }
      await delay(50);
    }

    expect(statusCode, stderr).toBe(200);
    expect(stderr).toContain('grunt routes: opening zro');
    expect(stderr).not.toContain('Cannot find module');
    expect(stderr).not.toContain('grunt recovery stopped:');
  } finally {
    child.kill();
    await closed;
  }
}, 20000);
